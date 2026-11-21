import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MarkdownStyle } from "../ui/glow";
import { type ThemeName, themes } from "../ui/theme";

/** Settings and prompt history live here; `BTR_HOME` moves them (tests use it). */
export const HOME = process.env.BTR_HOME ?? join(homedir(), ".btr");
export const SETTINGS_FILE = join(HOME, "config.json");

/** What btr remembers between runs. A new one needs a default below. */
export type Settings = {
  /** "auto" follows the terminal: fx when it is dark, fx-light when it is light. */
  theme: "auto" | ThemeName;
  /** Paint the theme's background instead of keeping the terminal's (off by default). */
  background: boolean;
  /** How replies are styled: like glow, or in btr's own colors. */
  markdown: MarkdownStyle;
  /** Show the sidebar when the window is wide enough. */
  sidebar: boolean;
  /** Ring the terminal bell when a turn ends or needs approval while the terminal is unfocused. */
  notifications: boolean;
};

export const DEFAULT_SETTINGS: Readonly<Settings> = { theme: "auto", background: false, markdown: "glow", sidebar: false, notifications: true };

/** Names from before the charm themes. */
const RENAMED_THEMES: Record<string, ThemeName> = { dark: "charm", light: "daylight" };

export async function loadSettings(): Promise<Settings> {
  try {
    const saved = { ...DEFAULT_SETTINGS, ...(await Bun.file(SETTINGS_FILE).json()) };
    saved.theme = RENAMED_THEMES[saved.theme] ?? saved.theme;
    if (saved.theme !== "auto" && !Object.hasOwn(themes, saved.theme)) saved.theme = "auto";
    if (saved.markdown !== "btr") saved.markdown = "glow";
    // Only known keys: an old file may carry settings that no longer exist.
    return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, saved[k as keyof Settings]])) as Settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(s: Settings) {
  try {
    await mkdir(HOME, { recursive: true });
    await Bun.write(SETTINGS_FILE, JSON.stringify(s, null, 2) + "\n");
  } catch {
    // Settings that cannot be saved still apply to this run.
  }
}
