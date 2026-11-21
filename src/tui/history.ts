import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HOME } from "./settings";

const HISTORY_FILE = join(HOME, "history.jsonl");
const HISTORY_LIMIT = 500;

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
      for (const line of (await Bun.file(HISTORY_FILE).text()).split("\n")) {
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
        .then(() => appendFile(HISTORY_FILE, JSON.stringify({ cwd: this.cwd, text, ts: Date.now() }) + "\n"))
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
