import {
  Check,
  ChevronLeft,
  ChevronRight,
  EyeOff,
  LogOut,
  Palette,
  PanelBottomClose,
  PanelsTopLeft,
  Pin,
  SquareMinus,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { HarborMark } from "../components/icons/harbor-mark";
import type { TrayAction, TrayLayout, TrayPrefs, TraySnapshot } from "./types";

type Props = {
  snapshot: TraySnapshot;
  onAction: (action: TrayAction) => Promise<void>;
  onDismiss: () => void;
  onSubmenuChange: (open: boolean) => Promise<void>;
};

const preferenceRows: { id: keyof TrayPrefs; icon: LucideIcon }[] = [
  { id: "alwaysOnTop", icon: Pin },
  { id: "pauseMinimized", icon: SquareMinus },
  { id: "pauseUnfocused", icon: EyeOff },
  { id: "closeToTray", icon: PanelBottomClose },
];

function panelStyle(layout: TrayLayout, theme = false): CSSProperties {
  return {
    left: theme ? layout.themeX : layout.mainX,
    top: theme ? layout.themeY : layout.mainY,
    width: theme ? layout.themeWidth : layout.mainWidth,
    height: theme ? layout.themeHeight : layout.mainHeight,
  };
}

function focus(button: HTMLButtonElement | null | undefined) {
  button?.focus({ preventScroll: true });
  button?.scrollIntoView({ block: "nearest" });
}

export function TrayMenu({ snapshot, onAction, onDismiss, onSubmenuChange }: Props) {
  const [submenu, setSubmenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const running = useRef(false);
  const live = useRef(true);
  const submenuRequest = useRef(0);
  const moveThemeFocus = useRef(false);
  const mainButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const themeButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const display = snapshot.display;

  useEffect(() => {
    live.current = true;
    focus(mainButtons.current[0]);
    return () => {
      live.current = false;
    };
  }, [snapshot.openId]);

  useLayoutEffect(() => {
    if (!submenu || !moveThemeFocus.current) return;
    moveThemeFocus.current = false;
    const selected = display?.themes.findIndex((theme) => theme.id === display.themeId) ?? 0;
    focus(themeButtons.current[Math.max(0, selected)]);
  }, [submenu, display]);

  if (!display || !snapshot.open) return null;

  const { labels, themes, direction } = display;
  const openKey = direction === "rtl" ? "ArrowLeft" : "ArrowRight";
  const closeKey = direction === "rtl" ? "ArrowRight" : "ArrowLeft";

  const changeSubmenu = async (open: boolean, moveFocus = false) => {
    const request = ++submenuRequest.current;
    if (!open) setSubmenu(false);
    try {
      await onSubmenuChange(open);
      if (!live.current || request !== submenuRequest.current) return;
      moveThemeFocus.current = open && moveFocus;
      setSubmenu(open);
      if (moveFocus && !open) focus(mainButtons.current[1]);
      if (moveFocus && open && submenu) {
        moveThemeFocus.current = false;
        focus(
          themeButtons.current[
            Math.max(
              0,
              themes.findIndex((theme) => theme.id === display.themeId),
            )
          ],
        );
      }
    } catch (cause) {
      console.error("[harbor::tray] submenu failed", cause);
      if (live.current) setError(true);
    }
  };

  const run = async (action: TrayAction) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(false);
    try {
      await onAction(action);
    } catch (cause) {
      console.error("[harbor::tray] action failed", cause);
      if (live.current) setError(true);
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const inThemes = !!(event.target as HTMLElement).closest("[data-tray-themes]");
    const buttons = (inThemes ? themeButtons : mainButtons).current.filter(
      (button): button is HTMLButtonElement => !!button,
    );
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      if (submenu) void changeSubmenu(false, true);
      else onDismiss();
    } else if (event.key === "Tab") {
      event.preventDefault();
      onDismiss();
    } else if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      focus(buttons[next]);
    } else if (!inThemes && event.key === openKey && index === 1) {
      event.preventDefault();
      void changeSubmenu(true, true);
    } else if (inThemes && event.key === closeKey) {
      event.preventDefault();
      void changeSubmenu(false, true);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      (event.target as HTMLButtonElement).click();
    }
  };

  const row = (
    index: number,
    id: Exclude<TrayAction["type"], "theme">,
    Icon: LucideIcon,
    checked?: boolean,
  ) => (
    <button
      key={id}
      ref={(element) => {
        mainButtons.current[index] = element;
      }}
      type="button"
      tabIndex={-1}
      className="tray-row"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      aria-disabled={busy || undefined}
      data-tray-action={id}
      onClick={() => {
        void run({ type: id });
      }}
    >
      <span className="tray-row-icon">
        <Icon size={16} strokeWidth={1.75} aria-hidden />
      </span>
      <span className="tray-row-label">{labels[id]}</span>
      <span className="tray-row-state">
        {checked && <Check size={14} strokeWidth={2} aria-hidden />}
      </span>
    </button>
  );
  const Chevron = snapshot.layout.submenuSide === "left" ? ChevronLeft : ChevronRight;

  return (
    <div
      className="tray-envelope"
      dir={direction}
      onKeyDown={onKey}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="tray-panel tray-main-panel" style={panelStyle(snapshot.layout)}>
        <header className="tray-header">
          <HarborMark className="tray-brand-mark" />
          <span>Harbor</span>
        </header>
        <div className="tray-separator" role="separator" />
        <div role="menu" aria-label="Harbor" aria-busy={busy}>
          {row(0, "show", PanelsTopLeft)}
          <button
            ref={(element) => {
              mainButtons.current[1] = element;
            }}
            className="tray-row"
            type="button"
            tabIndex={-1}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={submenu}
            aria-controls="tray-theme-menu"
            data-tray-action="theme"
            onPointerEnter={() => {
              if (!submenu) void changeSubmenu(true);
            }}
            onClick={() => {
              void changeSubmenu(!submenu, true);
            }}
          >
            <span className="tray-row-icon">
              <Palette size={16} strokeWidth={1.75} aria-hidden />
            </span>
            <span className="tray-row-label">{labels.theme}</span>
            <span className="tray-row-state">
              <Chevron size={14} strokeWidth={1.75} aria-hidden />
            </span>
          </button>
          {preferenceRows.map(({ id, icon }, index) =>
            row(index + 2, id, icon, snapshot.prefs[id]),
          )}
          <div className="tray-separator" role="separator" />
          {row(6, "quit", LogOut)}
        </div>
        {error && (
          <div className="tray-error" role="alert">
            {labels.error}
          </div>
        )}
      </div>
      {submenu && (
        <div
          id="tray-theme-menu"
          className="tray-panel tray-theme-panel"
          role="menu"
          aria-label={labels.theme}
          data-tray-themes
          style={panelStyle(snapshot.layout, true)}
        >
          {themes.map((theme, index) => (
            <button
              key={theme.id}
              ref={(element) => {
                themeButtons.current[index] = element;
              }}
              className="tray-row tray-theme-row"
              type="button"
              tabIndex={-1}
              role="menuitemradio"
              aria-checked={theme.id === display.themeId}
              aria-disabled={busy || undefined}
              data-theme-id={theme.id}
              onClick={() => {
                void run({ type: "theme", value: theme.id });
              }}
            >
              <span className="tray-row-label">{theme.name}</span>
              <span className="tray-row-state">
                {theme.id === display.themeId && <Check size={14} strokeWidth={2} aria-hidden />}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
