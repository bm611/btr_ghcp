import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Settings and prompt history live here; `BTR_HOME` moves them (tests use it). */
export const HOME = process.env.BTR_HOME ?? join(homedir(), ".btr");
const SETTINGS = join(HOME, "config.json");
const HISTORY = join(HOME, "history.jsonl");
const HISTORY_LIMIT = 500;

export type Settings = {
  /** "auto" follows the terminal: fx when it is dark, fx-light when it is light. */
  theme: "auto" | "fx" | "fx-light" | "charm" | "daylight";
  /** Paint the theme's background instead of keeping the terminal's (off by default). */
  background: boolean;
  /** How replies are styled: like glow, or in btr's own colors. */
  markdown: "glow" | "btr";
  /** Show the sidebar when the window is wide enough. */
  sidebar: boolean;
  /** Show tool output and thinking in full. */
  verbose: boolean;
  /** Ring the terminal bell when a turn ends or needs approval while the terminal is unfocused. */
  notifications: boolean;
};

const defaults: Settings = { theme: "auto", background: false, markdown: "glow", sidebar: false, verbose: false, notifications: true };

export async function loadSettings(): Promise<Settings> {
  try {
    const saved = { ...defaults, ...(await Bun.file(SETTINGS).json()) };
    // Names from before the charm themes.
    if (saved.theme === "dark") saved.theme = "charm";
    if (saved.theme === "light") saved.theme = "daylight";
    if (!["auto", "fx", "fx-light", "charm", "daylight"].includes(saved.theme)) saved.theme = "auto";
    if (saved.markdown !== "btr") saved.markdown = "glow";
    return saved;
  } catch {
    return { ...defaults };
  }
}

export async function saveSettings(s: Settings) {
  try {
    await mkdir(HOME, { recursive: true });
    await Bun.write(SETTINGS, JSON.stringify(s, null, 2) + "\n");
  } catch {
    // Settings that cannot be saved still apply to this run.
  }
}

/** Prompt history for one working directory, oldest first. */
export class History {
  private entries: string[] = [];
  /** Index into `entries` while browsing; `entries.length` is the draft. */
  private at = 0;
  private draft = "";

  private constructor(private cwd: string) {}

  static async load(cwd: string) {
    const h = new History(cwd);
    try {
      for (const line of (await Bun.file(HISTORY).text()).split("\n")) {
        if (!line) continue;
        const e = JSON.parse(line) as { cwd: string; text: string };
        if (e.cwd === cwd) h.entries.push(e.text);
      }
    } catch {
      // No history yet.
    }
    h.entries = h.entries.slice(-HISTORY_LIMIT);
    h.at = h.entries.length;
    return h;
  }

  add(text: string) {
    if (!text.trim()) return;
    if (this.entries.at(-1) !== text) {
      this.entries.push(text);
      // Bun has no append; a failed write only loses this entry for later runs.
      mkdir(HOME, { recursive: true })
        .then(() => appendFile(HISTORY, JSON.stringify({ cwd: this.cwd, text, ts: Date.now() }) + "\n"))
        .catch(() => {});
    }
    this.reset();
  }

  reset() {
    this.at = this.entries.length;
    this.draft = "";
  }

  /** The entry before the current one, or null at the oldest. `current` is saved as the draft on the first step. */
  prev(current: string): string | null {
    if (this.at === 0) return null;
    if (this.at === this.entries.length) this.draft = current;
    return this.entries[--this.at]!;
  }

  /** The entry after the current one; the draft after the newest; null when not browsing. */
  next(): string | null {
    if (this.at >= this.entries.length) return null;
    this.at++;
    return this.at === this.entries.length ? this.draft : this.entries[this.at]!;
  }

  /** Newest first, without duplicates. */
  all(): string[] {
    return [...new Set(this.entries.toReversed())];
  }
}
