import { DEFAULT_THEME, resolveTokens, type ThemeSettings } from "./theme";

export type TrayThemeEntry = { id: string; name: string };

export type TrayLabels = {
  show: string;
  theme: string;
  alwaysOnTop: string;
  pauseMinimized: string;
  pauseUnfocused: string;
  closeToTray: string;
  quit: string;
  error: string;
};

export type TrayDisplay = {
  themeId: string;
  themes: TrayThemeEntry[];
  tokens: Record<string, string>;
  labels: TrayLabels;
  direction: "ltr" | "rtl";
  colorScheme: "light" | "dark";
  menuWidth: number;
  themeWidth: number;
};

export const TRAY_MENU_FONT = "13px system-ui";

export const TRAY_TOKEN_KEYS = [
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
] as const;

export function resolveTrayTokens(
  theme: ThemeSettings,
  computed: Partial<Record<string, string>>,
  supportsColor: (value: string) => boolean,
): Record<string, string> {
  const defaults = resolveTokens(DEFAULT_THEME);
  const active = resolveTokens(theme);
  const valid = (value: string | undefined): value is string =>
    !!value?.trim() &&
    !/^(?:inherit|initial|unset|revert(?:-layer)?|currentcolor)$/i.test(value.trim()) &&
    !/var\s*\(/i.test(value) &&
    supportsColor(value);
  return Object.fromEntries(
    TRAY_TOKEN_KEYS.map((key) => {
      const value = computed[key]?.trim();
      const fallback = active[key];
      return [key, valid(value) ? value : valid(fallback) ? fallback : defaults[key]];
    }),
  );
}

export function trayMenuWidths(
  labels: TrayLabels,
  themes: TrayThemeEntry[],
  measure: (text: string) => number,
): { menuWidth: number; themeWidth: number } {
  const widest = (values: string[]) =>
    values.reduce((width, text) => Math.max(width, measure(text)), 0);
  const commands = [
    labels.show,
    labels.theme,
    labels.alwaysOnTop,
    labels.pauseMinimized,
    labels.pauseUnfocused,
    labels.closeToTray,
    labels.quit,
  ];
  return {
    menuWidth: Math.min(420, Math.max(240, Math.ceil(widest(commands) + 76))),
    themeWidth: Math.min(
      360,
      Math.max(220, Math.ceil(widest(themes.map((theme) => theme.name)) + 64)),
    ),
  };
}
