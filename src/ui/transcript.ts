import type * as acp from "@agentclientprotocol/sdk";
import {
  BoxRenderable,
  type CliRenderer,
  DiffRenderable,
  MarkdownRenderable,
  type Renderable,
  type ScrollBoxRenderable,
  type StyledText,
  type SyntaxStyle,
  type TextChunk,
  TextRenderable,
  bold,
  fg,
  italic,
} from "@opentui/core";
import { clipLines, formatBytes, formatDuration, oneLine, truncStart } from "../core/format";
import { patchStats, toolFileChanges, toolHeader, toolMetrics, toolOutput, toolPatches, toolSummary, type ToolState } from "../core/tools";
import { type GlowPalette, type MarkdownStyle, glowBullets, glowHooks } from "./glow";
import { styled, todoLine, toneColor, toneGlyph, type Tone } from "./text";
import { G, type Theme } from "./theme";

/**
 * How each kind of tool call reads (by the name `toolHeader` gives it): the verbs shown
 * before its target (present while running, past once done) and its plain-word label
 * in a folded turn summary.
 */
const TOOLS: Record<string, { verbs: [string, string]; label: string }> = {
  Bash: { verbs: ["Running", "Ran"], label: "bash" },
  Read: { verbs: ["Reading", "Read"], label: "read" },
  Search: { verbs: ["Searching", "Searched"], label: "search" },
  Update: { verbs: ["Editing", "Edited"], label: "edit" },
  Write: { verbs: ["Writing", "Wrote"], label: "write" },
  Delete: { verbs: ["Deleting", "Deleted"], label: "delete" },
  Move: { verbs: ["Moving", "Moved"], label: "move" },
  Fetch: { verbs: ["Fetching", "Fetched"], label: "fetch" },
  Think: { verbs: ["Thinking", "Thought"], label: "think" },
};

export function toolVerb(name: string, status: ToolState["status"]): string {
  const v = TOOLS[name]?.verbs;
  if (!v) return name;
  return status === "completed" || status === "failed" ? v[1] : v[0];
}

/** What a prompt was typed as: a message to the agent, a shell command (!), or a note (#). */
export type InputMode = "prompt" | "bash" | "memory";

export type Item =
  /** The welcome line: a name, then dim details. */
  | { type: "splash"; name: string; detail: string }
  | {
      type: "user";
      text: string;
      mode: InputMode;
      /** Attached `@` files or images shown quietly beneath the prompt. */
      attachments?: string[];
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
  /** The line that closes a turn: model, mode, duration, plus optional reply text for one-click copy. */
  | { type: "footer"; text: string; tone?: Tone; replyText?: string }
  /** A finished turn's work, folded into one line above its reply. */
  | { type: "group"; members: Entry[]; expanded: boolean };

export type Entry<T extends Item = Item> = {
  item: T;
  node: Renderable;
  /** Per-entry expansion for individual tool calls and diffs. */
  expanded?: boolean;
  /** The Markdown view of a streaming reply, appended to in place. */
  md?: MarkdownRenderable;
  /** The header line of a streaming thought, updated in place in compact mode. */
  thoughtHead?: TextRenderable;
  /** The text node of a streaming thought, updated in place when expanded. */
  thoughtBody?: TextRenderable;
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
  /** Called when the user clicks a reply's copy action. */
  onCopy?: (text: string) => void;
};

/** Lines of tool or command output shown before "… +N lines". */
const CLIP = 6;
/** Lines shown even in verbose mode: a larger output would make every rebuild slow. */
const VERBOSE_CLIP = 400;
/** Lines of a read, search or fetch result shown in details mode, under its summary. */
const PREVIEW = 12;
/** Max lines of a diff shown inline before offering a click-to-expand toggle. */
const DIFF_CLIP = 24;

export class Transcript {
  readonly entries: Entry[] = [];
  private blinkOn = true;
  private _diffWrap = false;

  constructor(
    private renderer: CliRenderer,
    private scroll: ScrollBoxRenderable,
    /** The column inside the scroll box that holds the entries. */
    private box: Renderable,
    private ctx: TranscriptContext,
  ) {}

  get diffWrap() {
    return this._diffWrap;
  }

  toggleDiffWrap(): boolean {
    this._diffWrap = !this._diffWrap;
    this.rebuild();
    return this._diffWrap;
  }

  add<T extends Item>(item: T): Entry<T> {
    const entry = { item } as Entry<T>;
    entry.node = this.build(entry);
    this.entries.push(entry);
    this.box.add(entry.node);
    return entry;
  }

  /** A one-line message in the transcript. */
  note(text: string, tone: Tone = "dim") {
    return this.add({ type: "note", text, tone });
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
    entry.thoughtHead = undefined;
    entry.thoughtBody = undefined;
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

  /** Formats the single-line header for a thought entry. */
  private thoughtHeader(entry: Entry<Extract<Item, { type: "thought" }>>): StyledText {
    const th = this.ctx.theme();
    const item = entry.item;
    const expanded = !!entry.expanded || this.ctx.verbose();
    const label = item.ms === undefined ? "Thinking" : `Thought${item.ms >= 1000 ? ` for ${formatDuration(item.ms)}` : ""}`;
    const trimmed = item.text.trim();
    if (!expanded && trimmed && item.ms === undefined) {
      const lastLine = trimmed.split("\n").findLast((l) => l.trim()) ?? trimmed;
      return styled(fg(th.fgDim)(`${G.pending} ${label} `), fg(th.fgMuted)(oneLine(lastLine, 72)));
    }
    const chevron = trimmed ? fg(th.fgGutter)(` ${expanded ? G.open : G.closed}`) : "";
    return styled(fg(th.fgDim)(`${G.pending} ${label}`), chevron);
  }

  /** Appends streamed thinking text in place without rebuilding the entry tree. */
  appendThought(entry: Entry<Extract<Item, { type: "thought" }>>, text: string) {
    entry.item.text += text;
    if (entry.thoughtBody) {
      const th = this.ctx.theme();
      const trimmed = entry.item.text.trim();
      const shown = this.ctx.verbose() || entry.expanded ? trimmed : clipLines(trimmed, 3).text;
      entry.thoughtBody.content = styled(italic(fg(th.fgMuted)(shown)));
      return;
    }
    if (entry.thoughtHead) {
      entry.thoughtHead.content = this.thoughtHeader(entry);
      return;
    }
    this.update(entry);
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
    this.update(entry);
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

  /** Scrolls an entry into view, unfolding its group first if hidden. */
  scrollToEntry(entry: Entry) {
    if (entry.group && !entry.group.item.expanded) this.toggle(entry.group);
    if (entry.item.type === "tool" && !entry.expanded) {
      entry.expanded = true;
      this.update(entry);
    }
    this.scroll.afterLayout(() => {
      if (!entry.node.isDestroyed) this.scroll.scrollChildIntoView(entry.node, { align: "start", inset: 1 });
    });
  }

  /** Finds the latest tool or diff entry touching `path`, for jumping from the sidebar. */
  findFileEntry(path: string): Entry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.item.type === "tool") {
        const changes = toolFileChanges(e.item.tool, this.ctx.cwd);
        if (changes.some((c) => c.path === path) || toolHeader(e.item.tool, this.ctx.cwd).arg === path) return e;
      } else if (e.item.type === "diff") {
        const file = /^\+\+\+ (?:b\/)?(.+)$/m.exec(e.item.patch)?.[1]?.trim();
        if (file === path) return e;
      }
    }
    return undefined;
  }

  /** Blinks the icons of running tool calls; call it about twice a second. */
  tick() {
    this.blinkOn = !this.blinkOn;
    const busy = this.ctx.busy();
    for (const e of this.entries) {
      if (!e.dot || e.item.type !== "tool") continue;
      const running = e.item.tool.status === "pending" || e.item.tool.status === "in_progress";
      if (running) e.dot.fg = busy && !this.blinkOn ? this.ctx.theme().fgGutter : this.ctx.theme().fg;
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

  /** Output cut to a few lines unless expanded or verbose; clicking the cutoff expands the entry. */
  private outputLines(parent: Renderable, output: string, color: string, entry?: Entry, clip = true, cap?: number) {
    const th = this.ctx.theme();
    const expanded = !!entry?.expanded;
    const max = expanded ? VERBOSE_CLIP : (cap ?? (clip && !this.ctx.verbose() ? CLIP : VERBOSE_CLIP));
    const { text, hidden } = clipLines(output, max);
    parent.add(this.text(text, color, { flexShrink: 1 }));
    if (hidden) {
      const more = this.text(`${G.ellipsis} ${hidden} line${hidden === 1 ? "" : "s"} more${entry ? " (click to expand)" : ""}`, th.fgGutter);
      if (entry) {
        more.onMouseDown = () => {
          entry.expanded = true;
          this.update(entry);
        };
      }
      parent.add(more);
    }
  }

  /** Compact `+added -removed` chunks, omitting zero counts. */
  private diffStats(added: number, removed: number): TextChunk[] {
    const th = this.ctx.theme();
    const out: TextChunk[] = [];
    if (added) out.push(fg(th.diffAddedFg)(`+${added}`));
    if (added && removed) out.push(fg(th.fgGutter)(" "));
    if (removed) out.push(fg(th.diffRemovedFg)(`-${removed}`));
    return out;
  }

  diffView(patch: string, wrap = this._diffWrap) {
    const th = this.ctx.theme();
    return new DiffRenderable(this.renderer, {
      diff: patch,
      view: "unified",
      syntaxStyle: this.ctx.syntax(),
      wrapMode: wrap ? "word" : "none",
      flexShrink: 0,
      fg: th.fg,
      showLineNumbers: true,
      lineNumberFg: th.fgGutter,
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

  /** Adds a diff view, clipped in height unless expanded/verbose, with a click-to-expand footer. */
  private addPatch(parent: Renderable, patch: string, entry: Entry) {
    const th = this.ctx.theme();
    const lines = patch.split("\n").length;
    const clipped = lines > DIFF_CLIP && !entry.expanded && !this.ctx.verbose();
    if (!clipped) {
      parent.add(this.diffView(patch));
      return;
    }
    const frame = this.column({ maxHeight: DIFF_CLIP, overflow: "hidden" });
    frame.add(this.diffView(patch));
    parent.add(frame);
    const toggle = this.text(`${G.closed} Show full diff (+${lines - DIFF_CLIP} lines)`, th.fgDim);
    toggle.onMouseDown = () => {
      entry.expanded = true;
      this.update(entry);
    };
    parent.add(toggle);
  }

  private build(entry: Entry): Renderable {
    const th = this.ctx.theme();
    const verbose = this.ctx.verbose();
    const item = entry.item;

    switch (item.type) {
      case "group": {
        // "▸ 3 tool calls (1 read, 1 bash, 1 edit) · ctrl+d or click", then one "  path +a -r" line per edited file.
        const open = item.expanded || verbose;
        const tools = item.members.flatMap((m) => (m.item.type === "tool" ? [m.item.tool] : []));
        const counts = new Map<string, number>();
        const touched = new Map<string, { added: number; removed: number }>();
        for (const t of tools) {
          const label = TOOLS[toolHeader(t, this.ctx.cwd).name]?.label ?? "other";
          counts.set(label, (counts.get(label) ?? 0) + 1);
          for (const c of toolFileChanges(t, this.ctx.cwd)) {
            const cur = touched.get(c.path) ?? { added: 0, removed: 0 };
            cur.added += c.added;
            cur.removed += c.removed;
            touched.set(c.path, cur);
          }
        }
        const failed = tools.filter((t) => t.status === "failed");

        const chunks: TextChunk[] = [fg(th.fgDim)(`${open ? G.open : G.closed} `)];
        const sep = () => {
          if (chunks.length > 1) chunks.push(fg(th.fgGutter)(" · "));
        };
        if (tools.length) {
          chunks.push(fg(th.fg)(`${tools.length} tool call${tools.length === 1 ? "" : "s"}`));
          const breakdown = [...counts]
            .sort((a, b) => b[1] - a[1])
            .map(([label, n]) => (tools.length === 1 ? label : `${n} ${label}`))
            .join(", ");
          chunks.push(fg(th.fgDim)(` (${breakdown})`));
        }
        if (failed.length) {
          sep();
          chunks.push(fg(th.error)(`${failed.length} failed`));
        }
        if (!verbose) {
          sep();
          chunks.push(fg(th.fgGutter)(open ? "click to fold" : "ctrl+d or click"));
        }

        const toggle = () => this.toggle(entry as Entry<Extract<Item, { type: "group" }>>);
        const header = this.text(styled(...chunks), th.fgDim, { flexShrink: 1, wrapMode: "none", truncate: true });
        header.onMouseDown = toggle;
        // Folded, each edited file gets its own line under the summary: "  src/greet.ts +3 -2".
        const fileLines = open
          ? []
          : [...touched]
              .filter(([, f]) => f.added || f.removed)
              .map(([path, f]) => styled(fg(th.fgMuted)(`  ${truncStart(path, 48)} `), ...this.diffStats(f.added, f.removed)));
        const failLine = !open && failed.length ? toolHeader(failed[0]!, this.ctx.cwd) : undefined;
        if (!fileLines.length && !failLine) return header;

        const box = this.column();
        box.add(header);
        for (const line of fileLines) {
          const row = this.text(line, th.fgMuted, { flexShrink: 1, wrapMode: "none", truncate: true });
          row.onMouseDown = toggle;
          box.add(row);
        }
        if (failLine) {
          const sub = this.text(
            styled(fg(th.error)(`  ${G.fail} ${failLine.name}${failLine.arg ? ` ${truncStart(failLine.arg, 48)}` : ""}`)),
            th.error,
            { flexShrink: 1, wrapMode: "none", truncate: true },
          );
          sub.onMouseDown = toggle;
          box.add(sub);
        }
        return box;
      }

      case "splash":
        // fx greets with one line: its name, then the version and where help is.
        return this.text(styled(bold(fg(th.fg)(item.name)), fg(th.fgDim)(` ${item.detail}`)), th.fg, { flexShrink: 1 });

      case "user": {
        // A heavy rail and bold text, as fx draws a submitted prompt.
        const promptColor = item.mode === "prompt" ? th.info : th.fg;
        const box = this.column({ border: ["left"], borderStyle: "heavy", borderColor: promptColor, paddingLeft: 1 });
        const mark = item.mode === "bash" ? fg(th.fgMuted)("$ ") : item.mode === "memory" ? fg(th.fgMuted)("# ") : "";
        box.add(this.text(styled(mark, bold(fg(promptColor)(item.text))), promptColor, { flexShrink: 1 }));
        if (item.attachments?.length) {
          box.add(this.text(styled(fg(th.fgDim)(item.attachments.join("  "))), th.fgDim, { flexShrink: 1, wrapMode: "none", truncate: true }));
        }
        if (item.result) {
          const out = this.barred(th.separatorSubtle, { marginTop: 1 });
          this.outputLines(out, item.result.text || "(no output)", item.result.tone === "dim" || !item.result.tone ? th.fgMuted : toneColor(th, item.result.tone), entry, item.result.clip ?? true);
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
        const thoughtEntry = entry as Entry<Extract<Item, { type: "thought" }>>;
        const expanded = verbose || !!entry.expanded;
        const head = this.text(this.thoughtHeader(thoughtEntry), th.fgDim, {
          flexShrink: 1,
          wrapMode: "none",
          truncate: true,
        });
        entry.thoughtHead = head;
        if (item.text.trim()) {
          head.onMouseDown = () => {
            entry.expanded = !entry.expanded;
            this.update(entry);
          };
        }
        if (!expanded || !item.text.trim()) return head;
        const box = this.column();
        box.add(head);
        // The expanded thinking sits behind a faint bar, so it reads apart from the reply.
        const bar = this.barred(th.separatorSubtle);
        const trimmed = item.text.trim();
        const shown = verbose || entry.expanded ? trimmed : clipLines(trimmed, 3).text;
        entry.thoughtBody = this.text(styled(italic(fg(th.fgMuted)(shown))), th.fgMuted, { flexShrink: 1 });
        bar.add(entry.thoughtBody);
        box.add(bar);
        return box;
      }

      case "tool": {
        // Single-line by default while running ("● Ran ls -la src  10 lines  420ms ✓ ▸"); click or ctrl+d expands output.
        const tool = item.tool;
        const box = this.column();
        const { name, arg } = toolHeader(tool, this.ctx.cwd);
        const running = tool.status === "pending" || tool.status === "in_progress";
        const abandoned = running && !this.ctx.busy();
        const output = toolOutput(tool);
        const patches = toolPatches(tool, this.ctx.cwd);
        const summary = toolSummary(tool, this.ctx.cwd);
        const metrics = toolMetrics(tool, this.ctx.cwd);
        const expanded = !!entry.expanded || verbose;

        const dotColor =
          tool.status === "failed"
            ? th.error
            : tool.status === "completed"
              ? th.success
              : running && !abandoned
                ? th.fg
                : th.fgDim;
        const head = new BoxRenderable(this.renderer, { flexDirection: "row", flexShrink: 0 });
        entry.dot = this.text(abandoned ? G.stop : G.dot, dotColor, { width: 2 });
        head.add(entry.dot);

        const meta: TextChunk[] = [];
        if (patches.length && tool.status === "pending") {
          meta.push(fg(th.fgDim)(`  waiting for approval${G.ellipsis}`));
        } else if (metrics.added || metrics.removed) {
          meta.push(fg(th.fgGutter)("  "), ...this.diffStats(metrics.added, metrics.removed));
        } else if (tool.status === "completed" && name === "Fetch" && metrics.bytes > 0) {
          meta.push(fg(th.fgGutter)(`  ${formatBytes(metrics.bytes)}`));
        } else if (tool.status === "completed" && name === "Search") {
          meta.push(fg(th.fgGutter)(metrics.lines ? `  ${metrics.lines} line${metrics.lines === 1 ? "" : "s"}` : "  no matches"));
        } else if (tool.status === "completed" && metrics.lines > 0) {
          meta.push(fg(th.fgGutter)(`  ${metrics.lines} line${metrics.lines === 1 ? "" : "s"}`));
        }
        if (metrics.ms !== undefined && metrics.ms >= 150) {
          meta.push(fg(th.fgGutter)(`  ${metrics.ms < 1000 ? `${metrics.ms}ms` : formatDuration(metrics.ms)}`));
        }

        const collapsible = patches.some((p) => p.split("\n").length > DIFF_CLIP) || (!!output && tool.status !== "failed");
        const chevron = collapsible ? fg(th.fgGutter)(` ${expanded ? G.open : G.closed}`) : "";
        const mark =
          tool.status === "completed"
            ? fg(th.success)(` ${G.check}`)
            : tool.status === "failed"
              ? fg(th.error)(` ${G.fail}`)
              : "";

        head.add(
          this.text(
            styled(
              running ? bold(fg(th.fg)(toolVerb(name, tool.status))) : fg(th.fg)(toolVerb(name, tool.status)),
              arg ? fg(th.fgSubtle)(" " + arg) : "",
              ...meta,
              mark,
              chevron,
            ),
            th.fg,
            { flexShrink: 1, wrapMode: "none", truncate: true },
          ),
        );
        if (collapsible) {
          head.onMouseDown = () => {
            entry.expanded = !entry.expanded;
            this.update(entry);
          };
        }

        const out = this.barred(tool.status === "failed" ? th.error : th.separatorSubtle);
        if (tool.status === "failed") this.outputLines(out, output || "Failed", th.fgMuted, entry);
        else if (patches.length && tool.status === "pending") return head;
        else if (patches.length) {
          out.add(this.text(summary, th.fgMuted));
          for (const p of patches) this.addPatch(out, p, entry);
        } else if (expanded && (summary || output)) {
          if (summary) out.add(this.text(summary, th.fgMuted));
          if (output) this.outputLines(out, output, th.fgMuted, entry, !entry.expanded, entry.expanded ? VERBOSE_CLIP : PREVIEW);
        } else return head;
        box.add(head);
        box.add(out);
        return box;
      }

      case "plan": {
        const box = this.column();
        const done = item.entries.filter((e) => e.status === "completed").length;
        box.add(this.text(styled(fg(th.fg)(G.dot + " "), fg(th.fg)("To-dos"), fg(th.fgDim)(` · ${done}/${item.entries.length}`)), th.fg));
        const list = this.barred(th.separatorSubtle);
        for (const e of item.entries) list.add(this.text(todoLine(th, e), th.fg, { flexShrink: 1 }));
        box.add(list);
        return box;
      }

      case "note": {
        const color = toneColor(th, item.tone);
        return this.text(styled(fg(color)(toneGlyph(item.tone) + item.text)), color, { flexShrink: 1 });
      }

      case "footer": {
        const color = item.tone === "dim" || !item.tone ? th.fgFaint : toneColor(th, item.tone);
        if (!item.replyText || !this.ctx.onCopy) {
          return this.text(styled(fg(color)(item.text)), color, { flexShrink: 1 });
        }
        const row = new BoxRenderable(this.renderer, { flexDirection: "row", flexShrink: 0 });
        row.add(this.text(styled(fg(color)(item.text)), color, { flexShrink: 1 }));
        const copyBtn = this.text(styled(fg(th.fgGutter)("  ·  "), fg(th.fgDim)("copy")), th.fgDim, { flexShrink: 0 });
        const text = item.replyText;
        copyBtn.onMouseDown = () => this.ctx.onCopy?.(text);
        row.add(copyBtn);
        return row;
      }

      case "block":
        return this.text(item.text, th.fg, { flexShrink: 1 });

      case "diff": {
        const box = this.column();
        const { added, removed } = patchStats(item.patch);
        const file = /^\+\+\+ (?:b\/)?(.+)$/m.exec(item.patch)?.[1]?.trim() ?? "changes";
        const collapsed = entry.expanded === false;
        const head = this.text(
          styled(
            fg(th.fgDim)((collapsed ? G.closed : G.open) + " "),
            bold(fg(th.fg)(file)),
            ...(added || removed ? [fg(th.fgGutter)("  "), ...this.diffStats(added, removed)] : []),
            fg(th.fgGutter)(this._diffWrap ? "  [wrap]" : ""),
          ),
          th.fg,
        );
        head.onMouseDown = () => {
          entry.expanded = collapsed ? true : false;
          this.update(entry);
        };
        box.add(head);
        if (!collapsed) this.addPatch(box, item.patch, entry);
        return box;
      }
    }
  }
}
