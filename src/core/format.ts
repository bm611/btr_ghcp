import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";

const ELLIPSIS = "…";

/** `s` cut to `n` characters, ending in an ellipsis when cut. */
export const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + ELLIPSIS : s);

/** Cuts the start of `s` rather than its end, so a path keeps its file name. */
export const truncStart = (s: string, n: number) => (s.length > n ? ELLIPSIS + s.slice(s.length - n + 1) : s);

/** `s` on one line, its whitespace runs collapsed, cut to `max`. */
export const oneLine = (s: string, max = 120) => trunc(s.replace(/\s*\n\s*/g, " ").trim(), max);

/** The first line of `s`, cut to `n` characters: a session title as a label. */
export const firstLine = (s: string, n: number) => trunc(s.split("\n")[0]!, n);

/** The first sentence of `s`, without its full stop, cut to `n`: a command's description as a hint. */
export const firstSentence = (s: string, n: number) => trunc(s.split(/\.\s/)[0]!.replace(/\.$/, ""), n);

/** An amount the agent reported, such as "0.0123 USD". */
export const formatCost = (cost: { amount: number; currency: string }) => `${cost.amount.toFixed(4)} ${cost.currency}`;

/** A session's title, or its id when it has none, as a one-line label. */
export const sessionLabel = (s: { title?: string | null; sessionId: string }, n: number) => firstLine(s.title ?? s.sessionId, n);

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `path` with the home directory written as `~`. */
export function tildify(path: string) {
  const home = homedir();
  return path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

/** A path as the interface shows it: relative to `cwd` when inside it, else from `~`. */
export function shortPath(cwd: string, path: string) {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  if (!rel) return ".";
  return rel.startsWith("..") ? tildify(path) : rel;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTokens(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function timeAgo(iso?: string | null, now = Date.now()) {
  if (!iso) return "";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** The first `max` lines of `text` and how many were left out. */
export function clipLines(text: string, max: number): { text: string; hidden: number } {
  const lines = text.split("\n");
  if (lines.length <= max) return { text, hidden: 0 };
  return { text: lines.slice(0, max).join("\n"), hidden: lines.length - max };
}

/** The message of whatever was thrown. */
export function errorText(err: unknown): string {
  return String((err as { message?: unknown } | null)?.message ?? err);
}
