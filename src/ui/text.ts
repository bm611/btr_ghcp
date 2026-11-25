import type * as acp from "@agentclientprotocol/sdk";
import { type Renderable, StyledText, type TextChunk, bold, fg, strikethrough } from "@opentui/core";
import { G, type Theme } from "./theme";

/** How a message reads: its color and the mark before it. */
export type Tone = "dim" | "error" | "warning" | "success" | "info" | "text";

const chunk = (text: string): TextChunk => ({ __isChunk: true, text });

/** Styled text from chunks and plain strings. */
export const styled = (...parts: (TextChunk | string)[]) => new StyledText(parts.map((p) => (typeof p === "string" ? chunk(p) : p)));

export function toneColor(th: Theme, tone: Tone | undefined) {
  switch (tone) {
    case "error":
      return th.error;
    case "warning":
      return th.warning;
    case "success":
      return th.success;
    case "info":
      return th.info;
    case "text":
      return th.fg;
    default:
      return th.fgMuted;
  }
}

/** The mark fx puts before a notice: ✗ for errors, ⚠ for warnings, ✓ for success. */
export function toneGlyph(tone: Tone | undefined): string {
  return tone === "error" ? G.fail + " " : tone === "warning" ? G.warn + " " : tone === "success" ? G.check + " " : "";
}

/** One to-do, as the transcript, the sidebar and the pinned list draw it. */
export function todoLine(th: Theme, e: acp.PlanEntry): StyledText {
  if (e.status === "completed") return styled(fg(th.fgDim)(G.check + " "), strikethrough(fg(th.fgDim)(e.content)));
  if (e.status === "in_progress") return styled(fg(th.fg)(G.arrow + " "), bold(fg(th.fg)(e.content)));
  return styled(fg(th.fgGutter)(G.todo + " "), fg(th.fgSubtle)(e.content));
}

/** A color between `a` and `b`; `t` runs from 0 to 1. */
export function blend(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i]! - v) * Math.max(0, Math.min(1, t))).toString(16).padStart(2, "0")).join("");
}

/** `text` with each character colored along a gradient. `offset` and `span` place it inside a longer gradient. */
export function gradient(text: string, from: string, to: string, opts: { bold?: boolean; offset?: number; span?: number } = {}): TextChunk[] {
  const chars = [...text];
  const span = opts.span ?? chars.length;
  const offset = opts.offset ?? 0;
  return chars.map((ch, i) => {
    const c = fg(blend(from, to, span <= 1 ? 0 : (offset + i) / (span - 1)))(ch);
    return opts.bold ? bold(c) : c;
  });
}

/** A title followed by a hatched band that fills `width` cells, all on one gradient. Monochrome themes draw the title alone. */
export function hatchedTitle(th: Theme, title: string, width: number, trailing = 0): TextChunk[] {
  if (th.mono) return [bold(fg(th.fg)(title))];
  const fill = Math.max(0, width - title.length - 1 - trailing);
  const span = title.length + 1 + fill;
  return [
    ...gradient(title, th.primary, th.secondary, { bold: true, span }),
    fg(th.bg)(" "),
    ...gradient(G.hatch.repeat(fill), th.primary, th.secondary, { offset: title.length + 1, span }),
  ];
}

/** A section's name, then a thin rule out to `width` cells. */
export function sectionTitle(th: Theme, name: string, width: number): TextChunk[] {
  return [bold(fg(th.fgDim)(name)), fg(th.separatorSubtle)(" " + G.rule.repeat(Math.max(0, width - name.length - 1)))];
}

/** Removes and destroys every child of `node`. */
export function clearChildren(node: Renderable) {
  for (const c of node.getChildren()) {
    node.remove(c);
    c.destroyRecursively();
  }
}

/** Renders `text` with characters at `indices` highlighted in `matchColor` (bold). */
export function highlightMatches(
  text: string,
  indices: number[],
  baseColor: string,
  matchColor: string,
  baseBold = false,
): TextChunk[] {
  if (!indices.length) {
    const c = fg(baseColor)(text);
    return [baseBold ? bold(c) : c];
  }
  const set = new Set(indices);
  const out: TextChunk[] = [];
  let buf = "";
  let bufMatched = false;
  const flush = () => {
    if (!buf) return;
    if (bufMatched) out.push(bold(fg(matchColor)(buf)));
    else {
      const c = fg(baseColor)(buf);
      out.push(baseBold ? bold(c) : c);
    }
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (buf && hit !== bufMatched) flush();
    bufMatched = hit;
    buf += text[i]!;
  }
  flush();
  return out;
}
