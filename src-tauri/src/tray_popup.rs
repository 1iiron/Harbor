use std::collections::{BTreeMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::tray::TrayIcon;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

#[path = "tray_popup_geometry.rs"]
mod geometry;

pub const LABEL: &str = "harbor-tray-menu";
const EVENT: &str = "harbor://tray-menu-state";
const READY_TIMEOUT: Duration = Duration::from_secs(3);
const TOKEN_KEYS: [&str; 12] = [
    "--color-canvas",
    "--color-surface",
    "--color-elevated",
    "--color-raised",
    "--color-ink",
    "--color-ink-muted",
    "--color-ink-subtle",
    "--color-edge",
    "--color-edge-soft",
    "--color-accent",
    "--color-accent-soft",
    "--color-danger",
];

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeEntry {
    id: String,
    name: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Labels {
    show: String,
    theme: String,
    always_on_top: String,
    pause_minimized: String,
    pause_unfocused: String,
    close_to_tray: String,
    quit: String,
    error: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Direction {
    Ltr,
    Rtl,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ColorScheme {
    Light,
    Dark,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayDisplay {
    theme_id: String,
    themes: Vec<ThemeEntry>,
    tokens: BTreeMap<String, String>,
    labels: Labels,
    direction: Direction,
    color_scheme: ColorScheme,
    menu_width: f64,
    theme_width: f64,
}

impl TrayDisplay {
    fn validate(&self) -> Result<(), String> {
        if !self.menu_width.is_finite()
            || !self.theme_width.is_finite()
            || !(160.0..=600.0).contains(&self.menu_width)
            || !(160.0..=600.0).contains(&self.theme_width)
            || self.themes.is_empty()
            || self.themes.len() > 1024
            || self.tokens.len() != TOKEN_KEYS.len()
        {
            return Err("invalid tray display dimensions or catalog".into());
        }
        let mut ids = HashSet::new();
        for theme in &self.themes {
            if theme.id.is_empty()
                || theme.id.len() > 256
                || theme.name.trim().is_empty()
                || theme.name.len() > 512
                || !ids.insert(theme.id.as_str())
            {
                return Err("invalid tray theme catalog".into());
            }
        }
        if !ids.contains(self.theme_id.as_str()) {
            return Err("current tray theme is absent from catalog".into());
        }
        if self.tokens.iter().any(|(key, value)| {
            !TOKEN_KEYS.contains(&key.as_str()) || value.is_empty() || value.len() > 2048
        }) {
            return Err("invalid tray theme tokens".into());
        }
        if [
            &self.labels.show,
            &self.labels.theme,
            &self.labels.always_on_top,
            &self.labels.pause_minimized,
            &self.labels.pause_unfocused,
            &self.labels.close_to_tray,
            &self.labels.quit,
            &self.labels.error,
        ]
        .iter()
        .any(|label| label.trim().is_empty() || label.len() > 512)
        {
            return Err("invalid tray labels".into());
        }
        Ok(())
    }

    fn has_theme(&self, id: &str) -> bool {
        self.themes.iter().any(|theme| theme.id == id)
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    width: f64,
    height: f64,
    main_x: f64,
    main_y: f64,
    main_width: f64,
    main_height: f64,
    theme_x: f64,
    theme_y: f64,
    theme_width: f64,
    theme_height: f64,
    submenu_side: &'static str,
}

impl From<geometry::Geometry> for Layout {
    fn from(g: geometry::Geometry) -> Self {
        Self {
            width: g.width,
            height: g.height,
            main_x: g.main.x,
            main_y: g.main.y,
            main_width: g.main.width,
            main_height: g.main.height,
            theme_x: g.theme.x,
            theme_y: g.theme.y,
            theme_width: g.theme.width,
            theme_height: g.theme.height,
            submenu_side: if g.submenu_left { "left" } else { "right" },
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: u64,
    open_id: u64,
    open: bool,
    prefs: crate::tray::TrayPrefs,
    display: Option<TrayDisplay>,
    layout: Layout,
}

#[derive(Default)]
struct Popup {
    enabled: bool,
    creating: bool,
    revision: u64,
    open_id: u64,
    open: bool,
    presented: bool,
    display: Option<TrayDisplay>,
    geometry: Option<geometry::Geometry>,
    watchdog: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl Popup {
    fn can_present(&self, id: u64) -> bool {
        self.open && self.open_id == id && !self.presented && self.display.is_some()
    }

    fn cancel_watchdog(&mut self) {
        if let Some(watchdog) = self.watchdog.take() {
            watchdog.abort();
        }
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            revision: self.revision,
            open_id: self.open_id,
            open: self.open,
            prefs: crate::tray::current_prefs(),
            display: self.display.clone(),
            layout: self.geometry.map(Layout::from).unwrap_or_else(|| Layout {
                submenu_side: "right",
                ..Layout::default()
            }),
        }
    }
}

#[derive(Default)]
struct PopupState(Mutex<Popup>);

fn with_state<T>(app: &AppHandle, f: impl FnOnce(&mut Popup) -> T) -> Result<T, String> {
    let state = app
        .try_state::<PopupState>()
        .ok_or("tray menu unavailable")?;
    let mut state = state.0.lock().map_err(|_| "tray menu state unavailable")?;
    Ok(f(&mut state))
}

fn emit_state(app: &AppHandle) -> Result<Snapshot, String> {
    let snapshot = with_state(app, |state| state.snapshot())?;
    app.emit_to(LABEL, EVENT, &snapshot)
        .map_err(|error| error.to_string())?;
    Ok(snapshot)
}

fn check_caller_label(label: &str, expected: &str) -> Result<(), String> {
    if label != expected {
        return Err("tray command unavailable to this window".into());
    }
    Ok(())
}

fn check_caller(window: &WebviewWindow, expected: &str) -> Result<(), String> {
    check_caller_label(window.label(), expected)
}

pub fn initialize(app: &AppHandle, tray: &TrayIcon) -> Result<(), String> {
    app.manage(PopupState::default());
    // Keep the native menu attached for immediate fallback, but avoid showing both menus.
    tray.with_inner_tray_icon(|inner| inner.set_show_menu_on_right_click(false))
        .map_err(|error| error.to_string())?;
    with_state(app, |state| state.enabled = true)?;
    ensure_window(app.clone());
    Ok(())
}

fn ensure_window(app: AppHandle) {
    let create = with_state(&app, |state| {
        if !state.enabled || state.creating || app.get_webview_window(LABEL).is_some() {
            return false;
        }
        state.creating = true;
        true
    });
    if !matches!(create, Ok(true)) {
        return;
    }
    // WebView2 creation must not run in a synchronous tray/event callback.
    std::thread::spawn(move || {
        let result = (|| -> Result<WebviewWindow, String> {
            let tray = app
                .tray_by_id("harbor-tray")
                .ok_or("tray owner unavailable")?;
            let owner = tray
                .with_inner_tray_icon(|inner| inner.window_handle() as isize)
                .map_err(|error| error.to_string())?;
            if owner == 0 {
                return Err("tray owner unavailable".into());
            }
            // The persistent hidden tray window keeps this popup out of Alt+Tab
            // without inheriting the main window's minimize/hide behavior.
            WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("tray.html".into()))
                .owner_raw(windows::Win32::Foundation::HWND(owner as *mut _))
                .title("Harbor")
                .inner_size(520.0, 450.0)
                .visible(false)
                .focused(false)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .skip_taskbar(true)
                .always_on_top(true)
                .build()
                .map_err(|error| error.to_string())
        })();
        match result {
            Ok(window) => {
                if let Err(error) = with_state(&app, |state| state.creating = false) {
                    eprintln!("[harbor::tray] window state: {error}");
                }
                if !with_state(&app, |state| state.enabled).unwrap_or(false)
                    || app.get_webview_window("main").is_none()
                {
                    if let Err(error) = window.destroy() {
                        eprintln!("[harbor::tray] late window cleanup: {error}");
                    }
                    return;
                }
                let handle = app.clone();
                window.on_window_event(move |event| match event {
                    WindowEvent::Focused(false) => {
                        if matches!(with_state(&handle, |state| state.presented), Ok(true)) {
                            if let Err(error) = dismiss(&handle) {
                                eprintln!("[harbor::tray] dismiss: {error}");
                            }
                        }
                    }
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        if let Err(error) = dismiss(&handle) {
                            eprintln!("[harbor::tray] dismiss: {error}");
                        }
                    }
                    _ => {}
                });
            }
            Err(error) => {
                let requested = with_state(&app, |state| {
                    state.creating = false;
                    if state.open {
                        Some(state.open_id)
                    } else {
                        None
                    }
                });
                if let Ok(Some(id)) = requested {
                    fallback(&app, id, &format!("create menu: {error}"));
                } else {
                    eprintln!("[harbor::tray] create menu: {error}");
                }
            }
        }
    });
}

fn place(
    app: &AppHandle,
    anchor: tauri::Rect,
    display: &TrayDisplay,
) -> Result<geometry::Geometry, String> {
    let position = anchor.position.to_physical::<f64>(1.0);
    let size = anchor.size.to_physical::<f64>(1.0);
    let monitor = app
        .monitor_from_point(
            position.x + size.width / 2.0,
            position.y + size.height / 2.0,
        )
        .map_err(|error| error.to_string())?
        .ok_or("tray monitor unavailable")?;
    let work = monitor.work_area();
    geometry::calculate(
        geometry::Rect {
            x: work.position.x as f64,
            y: work.position.y as f64,
            width: work.size.width as f64,
            height: work.size.height as f64,
        },
        geometry::Rect {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        monitor.scale_factor(),
        display.menu_width,
        display.theme_width,
        display.themes.len(),
        matches!(display.direction, Direction::Rtl),
    )
    .map_err(str::to_string)
}

pub fn request_open(app: &AppHandle, anchor: tauri::Rect) {
    let prepared = (|| -> Result<Option<u64>, String> {
        let request = with_state(app, |state| {
            if state.enabled {
                state.cancel_watchdog();
                state.open_id = state.open_id.wrapping_add(1);
                state.revision = state.revision.wrapping_add(1);
                state.open = true;
                state.presented = false;
                Ok((state.open_id, state.display.clone()))
            } else {
                Err("native menu active")
            }
        })?;
        let (id, display) = match request {
            Err(_) => return Ok(None),
            Ok((id, display)) => (id, display.ok_or("tray theme not ready")?),
        };
        let geometry = place(app, anchor, &display)?;
        with_state(app, |state| {
            state.geometry = Some(geometry);
        })?;
        if let Some(window) = app.get_webview_window(LABEL) {
            window.hide().map_err(|error| error.to_string())?;
        }
        ensure_window(app.clone());
        emit_state(app)?;
        Ok(Some(id))
    })();
    match prepared {
        Ok(Some(id)) => {
            let handle = app.clone();
            let watchdog = tauri::async_runtime::spawn(async move {
                tokio::time::sleep(READY_TIMEOUT).await;
                let fallback_handle = handle.clone();
                if let Err(error) = handle.run_on_main_thread(move || {
                    if matches!(
                        with_state(&fallback_handle, |state| state.open
                            && state.open_id == id
                            && !state.presented),
                        Ok(true)
                    ) {
                        fallback(&fallback_handle, id, "menu render timeout");
                    }
                }) {
                    eprintln!("[harbor::tray] schedule fallback: {error}");
                }
            });
            if let Err(error) = with_state(app, |state| {
                if state.open && state.open_id == id && !state.presented {
                    state.watchdog = Some(watchdog);
                } else {
                    watchdog.abort();
                }
            }) {
                eprintln!("[harbor::tray] watchdog: {error}");
            }
        }
        Ok(None) => {}
        Err(error) => {
            let id = with_state(app, |state| state.open_id).unwrap_or_default();
            fallback(app, id, &error);
        }
    }
}

fn fallback(app: &AppHandle, id: u64, error: &str) {
    let current = with_state(app, |state| state.open && state.open_id == id).unwrap_or(false);
    if !current {
        return;
    }
    eprintln!("[harbor::tray] {error}; using native menu");
    if let Err(error) = dismiss(app) {
        eprintln!("[harbor::tray] fallback dismiss: {error}");
    }
    if let Some(tray) = app.tray_by_id("harbor-tray") {
        if let Err(error) = tray.with_inner_tray_icon(|inner| inner.show_menu()) {
            eprintln!("[harbor::tray] native fallback: {error}");
        }
    }
}

fn dismiss(app: &AppHandle) -> Result<Snapshot, String> {
    with_state(app, |state| {
        state.cancel_watchdog();
        state.open = false;
        state.presented = false;
        state.revision = state.revision.wrapping_add(1);
    })?;
    if let Some(window) = app.get_webview_window(LABEL) {
        window.hide().map_err(|error| error.to_string())?;
    }
    emit_state(app)
}

pub fn prefs_changed(app: &AppHandle) -> Result<(), String> {
    if app.try_state::<PopupState>().is_none() {
        return Ok(());
    }
    with_state(app, |state| state.revision = state.revision.wrapping_add(1))?;
    emit_state(app).map(|_| ())
}

pub fn destroy(app: &AppHandle) -> Result<(), String> {
    if app.try_state::<PopupState>().is_none() {
        return Ok(());
    }
    with_state(app, |state| {
        state.cancel_watchdog();
        state.enabled = false;
        state.open = false;
        state.presented = false;
    })?;
    if let Some(window) = app.get_webview_window(LABEL) {
        window.destroy().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn set_region(window: &WebviewWindow, g: geometry::Geometry, submenu: bool) -> Result<(), String> {
    use windows::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_ERROR, RGN_OR,
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let create = |r: geometry::Rect| unsafe {
        CreateRectRgn(
            (r.x * g.scale).floor() as i32,
            (r.y * g.scale).floor() as i32,
            ((r.x + r.width) * g.scale).ceil() as i32,
            ((r.y + r.height) * g.scale).ceil() as i32,
        )
    };
    let region = create(g.main);
    if region.is_invalid() {
        return Err("create tray window region failed".into());
    }
    let result = (|| {
        if submenu {
            let bridge_left = if g.submenu_left {
                g.theme.x + g.theme.width
            } else {
                g.main.x + g.main.width
            };
            let bridge_y = (g.main.y + geometry::THEME_ROW_TOP).clamp(
                g.main.y.max(g.theme.y),
                (g.main.y + g.main.height).min(g.theme.y + g.theme.height) - 32.0,
            );
            for rect in [
                g.theme,
                geometry::Rect {
                    x: bridge_left,
                    y: bridge_y,
                    width: 6.0,
                    height: 32.0,
                },
            ] {
                let part = create(rect);
                if part.is_invalid() {
                    return Err("create tray submenu region failed".into());
                }
                let combined =
                    unsafe { CombineRgn(Some(region), Some(region), Some(part), RGN_OR) };
                unsafe {
                    let _ = DeleteObject(part.into());
                }
                if combined == RGN_ERROR {
                    return Err("combine tray submenu region failed".into());
                }
            }
        }
        if unsafe { SetWindowRgn(hwnd, Some(region), true) } == 0 {
            return Err("set tray window region failed".into());
        }
        Ok(())
    })();
    // On success Windows owns the region; failures leave ownership with us.
    if result.is_err() {
        unsafe {
            let _ = DeleteObject(region.into());
        }
    }
    result
}

#[tauri::command]
pub fn tray_popup_publish(
    window: WebviewWindow,
    app: AppHandle,
    display: TrayDisplay,
) -> Result<Snapshot, String> {
    check_caller(&window, "main")?;
    display.validate()?;
    with_state(&app, |state| {
        state.display = Some(display);
        state.revision = state.revision.wrapping_add(1);
    })?;
    emit_state(&app)
}

#[tauri::command]
pub fn tray_popup_snapshot(window: WebviewWindow, app: AppHandle) -> Result<Snapshot, String> {
    check_caller(&window, LABEL)?;
    with_state(&app, |state| state.snapshot())
}

#[tauri::command]
pub fn tray_popup_present(
    window: WebviewWindow,
    app: AppHandle,
    open_id: u64,
) -> Result<Snapshot, String> {
    check_caller(&window, LABEL)?;
    let geometry = with_state(&app, |state| {
        if state.can_present(open_id) {
            state.geometry
        } else {
            None
        }
    })?;
    let Some(geometry) = geometry else {
        return with_state(&app, |state| state.snapshot());
    };
    let present = (|| -> Result<(), String> {
        window
            .set_position(PhysicalPosition::new(geometry.x, geometry.y))
            .map_err(|error| error.to_string())?;
        window
            .set_size(PhysicalSize::new(
                (geometry.width * geometry.scale).ceil() as u32,
                (geometry.height * geometry.scale).ceil() as u32,
            ))
            .map_err(|error| error.to_string())?;
        set_region(&window, geometry, false)?;
        let current = with_state(&app, |state| {
            if !state.open || state.open_id != open_id {
                return false;
            }
            state.presented = true;
            state.cancel_watchdog();
            true
        })?;
        if !current {
            return Ok(());
        }
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        Ok(())
    })();
    if let Err(error) = present {
        fallback(&app, open_id, &error);
        return Err(error);
    }
    with_state(&app, |state| state.snapshot())
}

#[tauri::command]
pub fn tray_popup_dismiss(window: WebviewWindow, app: AppHandle) -> Result<Snapshot, String> {
    check_caller(&window, LABEL)?;
    dismiss(&app)
}

#[tauri::command]
pub fn tray_popup_submenu(
    window: WebviewWindow,
    app: AppHandle,
    open: bool,
) -> Result<Snapshot, String> {
    check_caller(&window, LABEL)?;
    let geometry = with_state(&app, |state| if state.open { state.geometry } else { None })?;
    if let Some(geometry) = geometry {
        set_region(&window, geometry, open)?;
    }
    with_state(&app, |state| state.snapshot())
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    Show,
    AlwaysOnTop,
    PauseMinimized,
    PauseUnfocused,
    CloseToTray,
    Quit,
    Theme { value: String },
}

#[tauri::command]
pub fn tray_popup_action(
    window: WebviewWindow,
    app: AppHandle,
    action: Action,
) -> Result<Snapshot, String> {
    check_caller(&window, LABEL)?;
    let id = match action {
        Action::Show => "tray_show".into(),
        Action::AlwaysOnTop => "tray_aot".into(),
        Action::PauseMinimized => "tray_pmin".into(),
        Action::PauseUnfocused => "tray_punf".into(),
        Action::CloseToTray => "tray_ctt".into(),
        Action::Quit => "tray_quit".into(),
        Action::Theme { value } => {
            let valid = with_state(&app, |state| {
                state
                    .display
                    .as_ref()
                    .is_some_and(|display| display.has_theme(&value))
            })?;
            if !valid {
                return Err("unknown tray theme".into());
            }
            format!("tray_theme_{value}")
        }
    };
    let dismiss_first = id == "tray_show" || id == "tray_quit";
    if dismiss_first {
        dismiss(&app)?;
    }
    crate::tray::dispatch(&app, &id)?;
    if dismiss_first {
        with_state(&app, |state| state.snapshot())
    } else {
        dismiss(&app)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display() -> TrayDisplay {
        let labels = Labels {
            show: "Show".into(),
            theme: "Theme".into(),
            always_on_top: "Always on Top".into(),
            pause_minimized: "Pause When Minimized".into(),
            pause_unfocused: "Pause When Unfocused".into(),
            close_to_tray: "Close to Tray".into(),
            quit: "Quit".into(),
            error: "Try again".into(),
        };
        TrayDisplay {
            theme_id: "cool-grey".into(),
            themes: vec![ThemeEntry {
                id: "cool-grey".into(),
                name: "Harbor default".into(),
            }],
            tokens: TOKEN_KEYS
                .iter()
                .map(|key| (key.to_string(), "#111111".into()))
                .collect(),
            labels,
            direction: Direction::Ltr,
            color_scheme: ColorScheme::Dark,
            menu_width: 280.0,
            theme_width: 230.0,
        }
    }

    #[test]
    fn publish_and_actions_accept_only_their_exact_window_label() {
        assert!(check_caller_label("main", "main").is_ok());
        assert!(check_caller_label(LABEL, LABEL).is_ok());
        for label in ["main", "harbor-browser", "harbor-tray-menu-other", ""] {
            assert!(check_caller_label(label, LABEL).is_err());
        }
        assert!(check_caller_label(LABEL, "main").is_err());
    }

    #[test]
    fn catalog_rejects_duplicate_and_unpublished_theme_ids() {
        let mut data = display();
        assert!(data.validate().is_ok());
        assert!(!data.has_theme("user:unpublished"));
        data.theme_id = "user:unpublished".into();
        assert!(data.validate().is_err());
        data.theme_id = "cool-grey".into();
        data.themes.push(data.themes[0].clone());
        assert!(data.validate().is_err());
    }

    #[test]
    fn only_semantic_tokens_and_bounded_labels_enter_popup() {
        let mut data = display();
        data.tokens.remove("--color-danger");
        data.tokens.insert("--unrelated".into(), "red".into());
        assert!(data.validate().is_err());
        let mut data = display();
        data.labels.show = "x".repeat(513);
        assert!(data.validate().is_err());
        let mut data = display();
        data.menu_width = f64::INFINITY;
        assert!(data.validate().is_err());
    }

    #[test]
    fn unknown_or_malformed_actions_cannot_reach_dispatcher() {
        for payload in [
            r#"{"type":"execute","value":"anything"}"#,
            r#"{"type":"theme"}"#,
            r#"{"type":"theme","value":"nord","extra":true}"#,
        ] {
            assert!(serde_json::from_str::<Action>(payload).is_err());
        }
        assert!(
            matches!(serde_json::from_str::<Action>(r#"{"type":"theme","value":"nord"}"#).unwrap(), Action::Theme { value } if value == "nord")
        );
    }

    #[test]
    fn cancelled_stale_and_already_presented_requests_cannot_show() {
        let mut popup = Popup {
            open: true,
            open_id: 7,
            display: Some(display()),
            ..Popup::default()
        };
        assert!(popup.can_present(7));
        assert!(!popup.can_present(6));
        popup.open = false;
        assert!(!popup.can_present(7));
        popup.open = true;
        popup.presented = true;
        assert!(!popup.can_present(7));
    }

    #[tokio::test]
    async fn completion_cancels_and_removes_the_ready_watchdog() {
        let task = tokio::spawn(std::future::pending::<()>());
        let cancellation = task.abort_handle();
        let mut popup = Popup {
            watchdog: Some(tauri::async_runtime::JoinHandle::Tokio(task)),
            ..Popup::default()
        };
        popup.cancel_watchdog();
        assert!(popup.watchdog.is_none());
        tokio::time::timeout(Duration::from_secs(1), async {
            while !cancellation.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}
