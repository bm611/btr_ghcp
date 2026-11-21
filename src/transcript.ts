import type * as acp from "@agentclientprotocol/sdk";
import {
  BoxRenderable,
  DiffRenderable,
  MarkdownRenderable,
  type MarkdownOptions,
  RGBA,
  type CliRenderer,
  type Renderable,
  type ScrollBoxRenderable,
  StyledText,
  type SyntaxStyle,
  type TextChunk,
  TextRenderable,
  bg,
  bold,
  fg,
  italic,
  strikethrough,
} from "@opentui/core";
import { G, type GlowPalette, type MarkdownStyle, type Theme } from "./theme";
import { clipLines, formatDuration, patchStats, toolHeader, toolOutput, toolPatches, toolSummary, type ToolState } from "./tools";

/** The verbs fx writes before a tool's target: present tense while it runs, past once done. */
const VERBS: Record<string, [string, string]> = {
  Bash: ["Running", "Ran"],
  Read: ["Reading", "Read"],
  Search: ["Searching", "Searched"],
  Update: ["Editing", "Edited"],
  Write: ["Writing", "Wrote"],
  Delete: ["Deleting", "Deleted"],
  Move: ["Moving", "Moved"],
  Fetch: ["Fetching", "Fetched"],
  Think: ["Thinking", "Thought"],
};

/** One single-width icon per kind of tool, for a folded turn's summary. */
const KIND_ICONS: Record<string, string> = {
  Read: G.read,
  Search: G.search,
  Bash: G.shell,
  Update: G.edit,
  Write: G.write,
  Delete: G.del,
  Move: G.move,
  Fetch: G.fetch,
  Think: G.thought,
  Other: G.tools,
};

export function toolVerb(name: string, status: ToolState["status"]): string {
  const v = VERBS[name];
  if (!v) return name;
  return status === "completed" || status === "failed" ? v[1] : v[0];
}

export type Tone = "dim" | "error" | "warning" | "success" | "info" | "text";

export type Item =
  /** The welcome line: a name, then dim details. */
  | { type: "splash"; name: string; detail: string }
  | {
      type: "user";
      text: string;
      mode: "prompt" | "bash" | "memory";
      /** What a shell command printed, or where a note was saved, shown right under it. */
      result?: { text: string; tone?: Tone; clip?: boolean };
    }
  | { type: "assistant"; text: string; streaming: boolean }
  | { type: "thought"; text: string; since: number; ms?: number }
  | { type: "tool"; tool: ToolState }
  | { type: "plan"; entries: acp.PlanEntry[] }
  | { type: "note"; text: string; tone?: Tone }
  | { type: "block"; text: string | StyledText }
  | { type: "diff"; patch: string }
  /** The line that closes a turn: model, mode, duration. */
  | { type: "footer"; text: string; tone?: Tone }
  /** A finished turn's work, folded into one line above its reply. */
  | { type: "group"; members: Entry[]; expanded: boolean };

export type Entry<T extends Item = Item> = {
  item: T;
  node: Renderable;
  /** The Markdown view of a streaming reply, appended to in place. */
  md?: MarkdownRenderable;
  /** The status icon of a tool call, which blinks while it runs. */
  dot?: TextRenderable;
  /** The folded group this entry belongs to, if its turn has ended. */
  group?: Entry<Extract<Item, { type: "group" }>>;
};

export type TranscriptContext = {
  theme: () => Theme;
  syntax: () => SyntaxStyle;
  /** How replies are styled; glow uses its own palette and syntax colors. */
  markdown: () => { style: MarkdownStyle; palette: GlowPalette; syntax: SyntaxStyle };
  verbose: () => boolean;
  /** Whether a turn is running: tool calls only blink then. */
  busy: () => boolean;
  cwd: string;
};

/** Lines of tool or command output shown before "… +N lines". */
const CLIP = 6;
/** Lines shown even in verbose mode: a larger output would make every rebuild slow. */
const VERBOSE_CLIP = 400;
/** Lines of a read, search or fetch result shown in details mode, under its summary. */
const PREVIEW = 12;

const chunk = (text: string): TextChunk => ({ __isChunk: true, text });
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

/** A small colored label such as " ERROR ". */
export function badge(th: Theme, label: string, color: string): TextChunk {
  return bold(bg(color)(fg(th.bg)(` ${label} `)));
}

export class Transcript {
  readonly entries: Entry[] = [];
  private blinkOn = true;

  constructor(
    private renderer: CliRenderer,
    private scroll: ScrollBoxRenderable,
    /** The column inside the scroll box that holds the entries. */
    private box: Renderable,
    private ctx: TranscriptContext,
  ) {}

  add<T extends Item>(item: T): Entry<T> {
    const entry = { item } as Entry<T>;
    entry.node = this.build(entry);
    this.entries.push(entry);
    this.box.add(entry.node);
    return entry;
  }

  /** Whether an entry is folded away inside its group. */
  private hidden(entry: Entry) {
    return !!entry.group && !entry.group.item.expanded && !this.ctx.verbose();
  }

  /**
   * Folds `members`, the work of a finished turn, under one summary line placed where the
   * first of them was. Clicking the line, or ctrl+d, shows them again.
   */
  fold(members: Entry[]) {
    const first = members[0];
    if (!first) return;
    const group = { item: { type: "group", members, expanded: false } } as Entry<Extract<Item, { type: "group" }>>;
    group.node = this.build(group);
    this.entries.splice(this.entries.indexOf(first), 0, group);
    this.box.insertBefore(group.node, first.node);
    for (const m of members) m.group = group;
    this.applyFold(group);
  }

  toggle(group: Entry<Extract<Item, { type: "group" }>>) {
    group.item.expanded = !group.item.expanded;
    this.update(group);
    this.applyFold(group);
  }

  private applyFold(group: Entry<Extract<Item, { type: "group" }>>) {
    for (const m of group.item.members) m.node.visible = !this.hidden(m);
    // Lists draw their markers again when the layout moves; put glow's bullets back.
    if (this.ctx.markdown().style === "glow") for (const e of this.entries) if (e.md && e.node.visible) this.bullets(e.md);
  }

  /** Draws an entry again after its item changed. */
  update(entry: Entry) {
    const old = entry.node;
    entry.md = undefined;
    entry.dot = undefined;
    entry.node = this.build(entry);
    entry.node.visible = !this.hidden(entry);
    this.box.insertBefore(entry.node, old);
    this.box.remove(old);
    old.destroyRecursively();
  }

  /** Appends streamed text to a reply without rebuilding it. */
  append(entry: Entry<Extract<Item, { type: "assistant" }>>, text: string) {
    entry.item.text += text;
    if (!entry.md) return this.update(entry);
    entry.md.content = entry.item.text;
    if (this.ctx.markdown().style === "glow") this.bullets(entry.md);
  }

  /** Swaps a reply's bullets once its list markers are drawn, which happens in the frame's layout. */
  private bullets(md: MarkdownRenderable) {
    glowBullets(md);
    this.scroll.afterLayout(() => {
      if (!md.isDestroyed) glowBullets(md);
    });
  }

  finishReply(entry: Entry<Extract<Item, { type: "assistant" }>>) {
    entry.item.streaming = false;
    if (entry.md) entry.md.streaming = false;
  }

  remove(entry: Entry) {
    const i = this.entries.indexOf(entry);
    if (i < 0) return;
    this.entries.splice(i, 1);
    this.box.remove(entry.node);
    entry.node.destroyRecursively();
  }

  clear() {
    for (const e of this.entries.splice(0)) {
      this.box.remove(e.node);
      e.node.destroyRecursively();
    }
  }

  /** Draws everything again: after a theme change or a verbosity toggle. */
  rebuild() {
    for (const e of this.entries) this.update(e);
  }

  /** Blinks the icons of running tool calls; call it about twice a second. */
  tick() {
    this.blinkOn = !this.blinkOn;
    const busy = this.ctx.busy();
    for (const e of this.entries) {
      if (!e.dot || e.item.type !== "tool") continue;
      const running = e.item.tool.status === "pending" || e.item.tool.status === "in_progress";
      if (running) e.dot.fg = busy && !this.blinkOn ? this.ctx.theme().fgFaint : this.ctx.theme().fg;
    }
  }

  lastReply(): string {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const it = this.entries[i]!.item;
      if (it.type === "assistant" && it.text.trim()) return it.text;
    }
    return "";
  }

  /** The conversation as Markdown, for /export. */
  toMarkdown(): string {
    const out: string[] = [];
    for (const { item } of this.entries) {
      switch (item.type) {
        case "user":
          out.push(item.mode === "bash" ? `**!** \`${item.text}\`` : `## > ${item.text}`);
          if (item.result?.text) out.push("```\n" + item.result.text + "\n```");
          break;
        case "assistant":
          out.push(item.text.trim());
          break;
        case "thought":
          out.push(`> _${item.text.trim().replace(/\n/g, "\n> ")}_`);
          break;
        case "tool": {
          const { name, arg } = toolHeader(item.tool, this.ctx.cwd);
          out.push(`**${name}**${arg ? ` \`${arg}\`` : ""}`);
          for (const p of toolPatches(item.tool, this.ctx.cwd)) out.push("```diff\n" + p.trimEnd() + "\n```");
          const text = toolOutput(item.tool);
          if (text) out.push("```\n" + clipLines(text, 60).text + "\n```");
          break;
        }
        case "plan":
          out.push(item.entries.map((e) => `- [${e.status === "completed" ? "x" : " "}] ${e.content}`).join("\n"));
          break;
        case "note":
        case "footer":
          out.push(`_${item.text}_`);
          break;
        case "diff":
          out.push("```diff\n" + item.patch.trimEnd() + "\n```");
          break;
        case "group":
          break;
      }
    }
    return out.filter(Boolean).join("\n\n") + "\n";
  }

  // ── building ────────────────────────────────────────────────────────────
  private text(content: string | StyledText, color: string, extra: Record<string, unknown> = {}) {
    return new TextRenderable(this.renderer, { content, fg: color, flexShrink: 0, ...extra });
  }

  private column(extra: Record<string, unknown> = {}) {
    return new BoxRenderable(this.renderer, { flexDirection: "column", flexShrink: 0, ...extra });
  }

  /** A block with a thin bar on its left, for tool output, shell output and thinking. */
  private barred(color: string, extra: Record<string, unknown> = {}) {
    return this.column({ border: ["left"], borderStyle: "single", borderColor: color, paddingLeft: 1, ...extra });
  }

  /** Output cut to a few lines unless verbose. */
  private outputLines(parent: Renderable, output: string, color: string, clip = true, cap?: number) {
    const th = this.ctx.theme();
    const max = cap ?? (clip && !this.ctx.verbose() ? CLIP : VERBOSE_CLIP);
    const { text, hidden } = clipLines(output, max);
    parent.add(this.text(text, color, { flexShrink: 1 }));
    if (hidden) parent.add(this.text(`${G.ellipsis} ${hidden} line${hidden === 1 ? "" : "s"} more`, th.fgFaint));
  }

  diffView(patch: string) {
    const th = this.ctx.theme();
    return new DiffRenderable(this.renderer, {
      diff: patch,
      view: "unified",
      syntaxStyle: this.ctx.syntax(),
      wrapMode: "none",
      flexShrink: 0,
      fg: th.fg,
      showLineNumbers: true,
      lineNumberFg: th.fgFaint,
      lineNumberBg: th.mono ? "transparent" : th.bgPanel,
      contextBg: th.mono ? "transparent" : th.bgPanel,
      contextContentBg: th.mono ? "transparent" : th.bgPanel,
      addedBg: th.diffAdded,
      addedContentBg: th.diffAdded,
      addedLineNumberBg: th.diffAdded,
      addedSignColor: th.diffAddedFg,
      removedBg: th.diffRemoved,
      removedContentBg: th.diffRemoved,
      removedLineNumberBg: th.diffRemoved,
      removedSignColor: th.diffRemovedFg,
    });
  }

  private build(entry: Entry): Renderable {
    const th = this.ctx.theme();
    const verbose = this.ctx.verbose();
    const item = entry.item;

    switch (item.type) {
      case "group": {
        // "▸ ⚙ 8  ≡ 6  ⌕ 1  $ 1  ✎ 1  ∴ 3s": what the turn did, folded, one icon per kind.
        const open = item.expanded || verbose;
        const tools = item.members.flatMap((m) => (m.item.type === "tool" ? [m.item.tool] : []));
        const counts = new Map<string, number>();
        for (const t of tools) {
          const name = toolHeader(t, this.ctx.cwd).name;
          const kind = KIND_ICONS[name] ? name : "Other";
          counts.set(kind, (counts.get(kind) ?? 0) + 1);
        }
        const failed = tools.filter((t) => t.status === "failed").length;
        const thought = item.members.reduce((n, m) => n + (m.item.type === "thought" ? (m.item.ms ?? 0) : 0), 0);
        const hasThought = item.members.some((m) => m.item.type === "thought");

        const chunks: TextChunk[] = [fg(th.fgMuted)(`${open ? G.open : G.closed} `)];
        const stat = (icon: string, value: string, color = th.fgSubtle) => {
          if (chunks.length > 1) chunks.push(fg(th.fgFaint)("  "));
          chunks.push(fg(th.fgMuted)(icon + " "), fg(color)(value));
        };
        if (tools.length) stat(G.tools, `${tools.length} tool call${tools.length === 1 ? "" : "s"}`, th.fg);
        // Most used first; a single kind is already said by the total.
        if (counts.size > 1) for (const [kind, n] of [...counts].sort((a, b) => b[1] - a[1])) stat(KIND_ICONS[kind]!, String(n));
        if (failed) stat(G.fail, String(failed));
        if (hasThought) stat(G.thought, thought >= 1000 ? formatDuration(thought) : "thought");
        if (!this.ctx.verbose()) chunks.push(fg(th.fgFaint)(open ? "  click to fold" : "  click or ctrl+d to expand"));
        const node = this.text(styled(...chunks), th.fgMuted, { flexShrink: 1, wrapMode: "none", truncate: true });
        node.onMouseDown = () => this.toggle(entry as Entry<Extract<Item, { type: "group" }>>);
        return node;
      }

      case "splash":
        // fx greets with one line: its name, then the version and where help is.
        return this.text(styled(bold(fg(th.fg)(item.name)), fg(th.fgMuted)(` ${item.detail}`)), th.fg, { flexShrink: 1 });

      case "user": {
        // A heavy rail and bold text, as fx draws a submitted prompt.
        const box = this.column({ border: ["left"], borderStyle: "heavy", borderColor: th.fg, paddingLeft: 1 });
        const mark = item.mode === "bash" ? fg(th.fgMuted)("$ ") : item.mode === "memory" ? fg(th.fgMuted)("# ") : "";
        box.add(this.text(styled(mark, bold(fg(th.fg)(item.text))), th.fg, { flexShrink: 1 }));
        if (item.result) {
          const out = this.barred(th.separator, { marginTop: 1 });
          this.outputLines(out, item.result.text || "(no output)", item.result.tone === "dim" || !item.result.tone ? th.fgMuted : toneColor(th, item.result.tone), item.result.clip ?? true);
          box.add(out);
        }
        return box;
      }

      case "assistant": {
        const box = this.column();
        const md = this.ctx.markdown();
        const glow = md.style === "glow" ? md.palette : null;
        entry.md = new MarkdownRenderable(this.renderer, {
          content: item.text,
          syntaxStyle: glow ? md.syntax : this.ctx.syntax(),
          streaming: item.streaming,
          conceal: true,
          fg: glow ? glow.text : th.fg,
          flexShrink: 1,
          tableOptions: {
            borderColor: glow ? glow.rule : th.separator,
            widthMode: "content",
            cellPaddingX: 1,
            borderStyle: glow ? "single" : "rounded",
          },
          ...(glow ? glowHooks(this.renderer, glow) : {}),
        });
        box.add(entry.md);
        if (glow) this.bullets(entry.md);
        return box;
      }

      case "thought": {
        const box = this.column();
        const label = item.ms === undefined ? "Thinking" : `Thought${item.ms >= 1000 ? ` for ${formatDuration(item.ms)}` : ""}`;
        box.add(this.text(`${G.pending} ${label}`, th.fgMuted));
        if ((verbose || item.ms === undefined) && item.text.trim()) {
          // The thinking itself sits behind a faint bar, so it reads apart from the reply.
          const text = this.barred(th.separator);
          const shown = verbose ? item.text.trim() : clipLines(item.text.trim(), 3).text;
          text.add(this.text(styled(italic(fg(th.fgMuted)(shown))), th.fgMuted, { flexShrink: 1 }));
          box.add(text);
        }
        return box;
      }

      case "tool": {
        // "● Ran ls -la src ✓", its output behind a thin rail: fx's tool line.
        const tool = item.tool;
        const box = this.column();
        const { name, arg } = toolHeader(tool, this.ctx.cwd);
        const running = tool.status === "pending" || tool.status === "in_progress";
        // A call still open after its turn ended was abandoned: it no longer reads as busy.
        const dotColor = running && this.ctx.busy() ? th.fg : th.fgMuted;
        const head = new BoxRenderable(this.renderer, { flexDirection: "row", flexShrink: 0 });
        entry.dot = this.text(G.dot, dotColor, { width: 2 });
        head.add(entry.dot);
        const mark = tool.status === "completed" ? fg(th.fgMuted)(` ${G.check}`) : tool.status === "failed" ? fg(th.fgMuted)(` ${G.fail}`) : "";
        head.add(
          this.text(styled(fg(th.fg)(toolVerb(name, tool.status)), arg ? fg(th.fgSubtle)(" " + arg) : "", mark), th.fg, {
            flexShrink: 1,
            wrapMode: "none",
            truncate: true,
          }),
        );
        box.add(head);

        const output = toolOutput(tool);
        const patches = toolPatches(tool, this.ctx.cwd);
        const summary = toolSummary(tool, this.ctx.cwd);
        const out = this.barred(th.separator);
        if (tool.status === "failed") this.outputLines(out, output || "Failed", th.fgMuted);
        else if (patches.length && tool.status === "pending") out.add(this.text(`Waiting for approval${G.ellipsis}`, th.fgMuted));
        else if (patches.length) {
          out.add(this.text(summary, th.fgMuted));
          for (const p of patches) out.add(this.diffView(p));
        } else if (summary) {
          out.add(this.text(summary, th.fgMuted));
          // Details show a glimpse of what was read or found; the file itself is a click away,
          // and hundreds of lines of it would bury the turn.
          if (verbose && output) this.outputLines(out, output, th.fgMuted, true, PREVIEW);
        } else if (output) this.outputLines(out, output, th.fgMuted);
        else return box;
        box.add(out);
        return box;
      }

      case "plan": {
        const box = this.column();
        const done = item.entries.filter((e) => e.status === "completed").length;
        box.add(this.text(styled(fg(th.fg)(G.dot + " "), fg(th.fg)("To-dos"), fg(th.fgMuted)(` · ${done}/${item.entries.length}`)), th.fg));
        const list = this.barred(th.separator);
        for (const e of item.entries) list.add(this.text(todoLine(th, e), th.fg, { flexShrink: 1 }));
        box.add(list);
        return box;
      }

      case "note": {
        const color = toneColor(th, item.tone);
        return this.text(styled(fg(color)(toneGlyph(item.tone) + item.text)), color, { flexShrink: 1 });
      }

      case "footer":
        return this.text(styled(fg(item.tone === "dim" || !item.tone ? th.fgFaint : toneColor(th, item.tone))(item.text)), th.fgFaint, { flexShrink: 1 });

      case "block":
        return this.text(item.text, th.fg, { flexShrink: 1 });

      case "diff": {
        const box = this.column();
        const { added, removed } = patchStats(item.patch);
        const file = /^\+\+\+ (?:b\/)?(.+)$/m.exec(item.patch)?.[1]?.trim() ?? "changes";
        box.add(this.text(styled(fg(th.fg)(G.dot + " "), bold(fg(th.fg)(file)), fg(th.diffAddedFg)(`  +${added}`), fg(th.diffRemovedFg)(` -${removed}`)), th.fg));
        box.add(this.diffView(item.patch));
        return box;
      }
    }
  }
}

/** One to-do, as the transcript, the sidebar and the pinned list draw it. */
export function todoLine(th: Theme, e: acp.PlanEntry): StyledText {
  if (e.status === "completed") return styled(fg(th.fgMuted)(G.check + " "), strikethrough(fg(th.fgMuted)(e.content)));
  if (e.status === "in_progress") return styled(fg(th.fg)(G.arrow + " "), bold(fg(th.fg)(e.content)));
  return styled(fg(th.fgFaint)(G.todo + " "), fg(th.fgSubtle)(e.content));
}

/** The mark fx puts before a notice: ✗ for errors, ⚠ for warnings, ✓ for success. */
export function toneGlyph(tone: Tone | undefined): string {
  return tone === "error" ? G.fail + " " : tone === "warning" ? G.warn + " " : tone === "success" ? G.check + " " : "";
}

/**
 * The parts of glow's look that styles alone cannot give: headings keep their
 * `##` markers (a level-1 heading is a colored band), code blocks are indented,
 * and inline code is padded on a background.
 */
function glowHooks(renderer: CliRenderer, g: GlowPalette): Pick<MarkdownOptions, "renderBlock" | "inlineHook"> {
  const codeFg = RGBA.fromHex(g.codeFg);
  const codeBg = RGBA.fromHex(g.codeBg);
  return {
    renderBlock(block, context) {
      if (block.kind === "heading") {
        const level = block.level ?? 1;
        const content =
          level === 1
            ? styled(bold(bg(g.h1Bg)(fg(g.h1Fg)(` ${block.text} `))))
            : level === 6
              ? styled(fg(g.h6)(`${"#".repeat(level)} ${block.text}`))
              : styled(bold(fg(g.heading)(`${"#".repeat(level)} ${block.text}`)));
        return new TextRenderable(renderer, { content, flexShrink: 0, wrapMode: "word" });
      }
      if (block.kind === "code") {
        const code = context.defaultRender();
        if (code) code.marginLeft = 2;
        return code;
      }
      return undefined;
    },
    inlineHook: (spans) => spans.map((sp) => (sp.code ? { ...sp, text: ` ${sp.text} `, fg: codeFg, bg: codeBg } : sp)),
  };
}

/**
 * Draws list bullets as glow does, "•" in place of "-". OpenTUI fixes the marker text,
 * so this rewrites the markers it built; it runs again after every change of content,
 * since a change to a list draws its markers anew.
 */
function glowBullets(node: Renderable) {
  for (const child of node.getChildren() as Renderable[]) {
    if (child instanceof TextRenderable && child.id.endsWith("-marker")) {
      const chunks = child.content.chunks;
      const first = chunks[0];
      if (first && first.text.startsWith("-")) child.content = new StyledText([{ ...first, text: "•" + first.text.slice(1) }, ...chunks.slice(1)]);
    } else glowBullets(child);
  }
}
