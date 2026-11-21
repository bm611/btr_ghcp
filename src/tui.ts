import type * as acp from "@agentclientprotocol/sdk";
import {
  BoxRenderable,
  type KeyEvent,
  type Renderable,
  ScrollBoxRenderable,
  type SyntaxStyle,
  type TextChunk,
  TextRenderable,
  TextareaRenderable,
  bg,
  bold,
  createCliRenderer,
  fg,
} from "@opentui/core";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AGENT_LOG, VERSION, choices, currentName, routedModel, selectOption, startAgent, type Agent } from "./agent";
import { Attachments, mentionAt } from "./attachments";
import { HOME, History, loadSettings, saveSettings, type Settings } from "./config";
import { fuzzyFilter, listFiles } from "./files";
import { Menus, helpLine, type MenuOption } from "./menu";
import { G, blend, glowPalettes, glowSyntaxStyle, hatchedTitle, syntaxStyleFor, themes, type Theme } from "./theme";
import { formatDuration, formatTokens, shortPath, toolFileChanges, toolHeader, toolPatches, type ToolState } from "./tools";
import { toolVerb } from "./transcript";
import { Transcript, styled, todoLine, toneColor, toneGlyph, type Entry, type Item, type Tone } from "./transcript";

export type TuiOptions = {
  cwd: string;
  /** Sent as the first prompt. */
  prompt?: string;
  /** A session id to load, or true to pick one. */
  resume?: string | boolean;
  /** Load the most recent session for this directory. */
  continueLast?: boolean;
  model?: string;
  mode?: string;
};

type InputMode = "prompt" | "bash" | "memory";
/** A palette entry; `slash` also makes it a typed /command. */
type Action = { id: string; label: string; key?: string; slash?: string[]; hint?: string; run: (args: string) => unknown };

const MAX_COMPLETIONS = 8;
const SIDEBAR_WIDTH = 36;
/** Narrower windows hide the sidebar. */
const SIDEBAR_MIN_WINDOW = 110;
const PERMISSION_TITLE = "Permission needed";
const tildify = (p: string) => (p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p);
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + G.ellipsis : s);
/** Cuts the start of a path rather than its end, so the file name stays. */
const truncStart = (s: string, n: number) => (s.length > n ? G.ellipsis + s.slice(s.length - n + 1) : s);

export async function runTui(opts: TuiOptions) {
  const cwd = opts.cwd;
  const settings: Settings = await loadSettings();
  const history = await History.load(cwd);
  const attachments = new Attachments();

  const renderer = await createCliRenderer({ exitOnCtrlC: false, screenMode: "alternate-screen" });

  // ── theme ───────────────────────────────────────────────────────────────
  const resolveTheme = (): Theme => themes[settings.theme === "auto" ? (renderer.themeMode === "light" ? "fx-light" : "fx") : settings.theme];
  // The terminal's own background, for dialogs that must cover what is behind them when
  // the theme's background is off. Terminals that do not report it get plain white under
  // the light theme and the theme's own dark under the dark one.
  const termBg = await Promise.race([
    renderer.getPalette().then((p) => (p.defaultBackground as string) || null).catch(() => null),
    Bun.sleep(400).then(() => null),
  ]);
  /** The color behind everything: the theme's, or the terminal's. */
  const surface = () => (settings.background ? th.bg : (termBg ?? (th.light ? "#ffffff" : th.bg)));
  let th = resolveTheme();
  let syntax: SyntaxStyle = syntaxStyleFor(th, renderer.nativeScene);
  let glowSyntax: SyntaxStyle = glowSyntaxStyle(glowPalettes[th.name], renderer.nativeScene);

  // ── state ───────────────────────────────────────────────────────────────
  let agent: Agent | null = null;
  let disconnected = false;
  // Settles once the first session exists; prompts sent while copilot warms up wait on it.
  let markReady = () => {};
  const sessionReady = new Promise<void>((resolve) => (markReady = resolve));
  let busy = false;
  let replaying = false;
  let focused = true;
  let commands: acp.AvailableCommand[] = [];
  let usage: acp.UsageUpdate | null = null;
  let sessionTitle = "";
  let inputMode: InputMode = "prompt";
  let toast: { text: string; tone: Tone } | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let lastCtrlC = 0;
  let lastEsc = 0;
  let stash: string | null = null;
  let showTodos = false;
  let showHelp = false;
  let plan: acp.PlanEntry[] = [];
  let shell: ReturnType<typeof Bun.spawn> | null = null;
  /** Shell output the agent has not seen yet; it rides along with the next prompt. */
  const shellContext: string[] = [];
  const queue: string[] = [];
  const started = Date.now();
  let turns = 0;
  let turn: { since: number; chars: number; label: string; cancelled: boolean } | null = null;
  /** Lines each finished edit changed, by tool call. */
  const changes = new Map<string, { path: string; added: number; removed: number }[]>();

  // ── layout ──────────────────────────────────────────────────────────────
  const text = (extra: Record<string, unknown> = {}) => new TextRenderable(renderer, { content: "", flexShrink: 0, ...extra });

  const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%" });
  renderer.root.add(root);

  const body = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, flexShrink: 1 });
  root.add(body);

  const main = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, flexShrink: 1 });
  body.add(main);

  // The conversation takes only the rows it needs, so the prompt sits right under it, as
  // in fx; once it fills the window it shrinks to fit and scrolls, and the prompt stays at the bottom.
  const scroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 0,
    flexShrink: 1,
    stickyScroll: true,
    stickyStart: "bottom",
    // fx has no scrollbar: the conversation just scrolls.
    verticalScrollbarOptions: { visible: false },
    paddingX: 2,
    contentOptions: { flexDirection: "column" },
  });
  main.add(scroll);

  /**
   * A scroll box does not size itself to its content, so the entries sit in a column whose
   * size changes give the box its height. Shrinking stays on: once the conversation outgrows
   * the window, the box is squeezed to the rows left above the prompt, and scrolls.
   */
  const list = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0, gap: 1, paddingTop: 1 });
  scroll.add(list);
  list.onSizeChange = () => {
    const want = Math.max(1, list.height);
    if (scroll.height === want) return;
    scroll.height = want;
    // Setting a numeric height turns shrinking off.
    scroll.flexShrink = 1;
    // A conversation that shrank to fit (a turn folding) keeps its old offset: show it from the top.
    scroll.afterLayout(() => {
      if (scroll.scrollTop > 0 && scroll.scrollHeight <= scroll.height) scroll.scrollTop = 0;
    });
  };

  const transcript = new Transcript(renderer, scroll, list, {
    theme: () => th,
    syntax: () => syntax,
    markdown: () => ({ style: settings.markdown, palette: glowPalettes[th.name], syntax: glowSyntax }),
    verbose: () => settings.verbose,
    busy: () => busy,
    cwd,
  });

  const todoPanel = text({ marginTop: 1, paddingX: 2, visible: false });
  const spinner = text({ marginTop: 1, paddingX: 2, visible: false, wrapMode: "none", truncate: true });
  const queued = text({ marginTop: 1, paddingX: 2, visible: false });
  for (const n of [todoPanel, spinner, queued]) main.add(n);

  const completions = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexShrink: 0,
    marginLeft: 2,
    marginTop: 1,
    alignSelf: "flex-start",
    visible: false,
  });
  const completionRows = Array.from({ length: MAX_COMPLETIONS }, () => {
    const row = text({ wrapMode: "none", truncate: true });
    completions.add(row);
    return row;
  });
  main.add(completions);

  const inputBox = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0, marginTop: 1, paddingX: 2, paddingBottom: 1 });
  const promptMark = text({ width: 2 });
  const input = new TextareaRenderable(renderer, {
    flexGrow: 1,
    height: 1,
    minHeight: 1,
    maxHeight: 12,
    backgroundColor: "transparent",
    focusedBackgroundColor: "transparent",
    wrapMode: "word",
    keyBindings: [
      { name: "return", action: "submit" },
      { name: "kpenter", action: "submit" },
      // Ctrl+J, and terminals set up to send a line feed for Shift+Enter.
      { name: "linefeed", action: "newline" },
      { name: "return", shift: true, action: "newline" },
      { name: "kpenter", shift: true, action: "newline" },
      { name: "return", meta: true, action: "newline" },
    ],
  });
  inputBox.add(promptMark);
  inputBox.add(input);
  main.add(inputBox);

  const sidebar = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexShrink: 0,
    width: SIDEBAR_WIDTH,
    border: ["left"],
    paddingX: 1,
    paddingTop: 1,
  });
  const sidebarText = text({ flexShrink: 1 });
  sidebar.add(sidebarText);
  body.add(sidebar);

  const helpPanel = text({ paddingX: 2, paddingY: 1, visible: false, wrapMode: "none", truncate: true });
  main.add(helpPanel);

  const status = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0, paddingX: 2, paddingBottom: 1, justifyContent: "space-between" });
  const statusLeft = text({ flexShrink: 1, wrapMode: "none", truncate: true });
  const statusRight = text({ wrapMode: "none", marginLeft: 2 });
  status.add(statusLeft);
  status.add(statusRight);
  main.add(status);
  // Takes up whatever room is left below the prompt.
  main.add(new BoxRenderable(renderer, { flexGrow: 1, flexShrink: 1, minHeight: 0 }));

  const menus = new Menus(renderer, () => ({ ...th, bg: surface() }), (open) => {
    if (open) input.blur();
    else input.focus();
    drawSpinner();
    drawCompletions();
    drawStatus();
  });
  input.focus();

  // ── small helpers ───────────────────────────────────────────────────────
  function note(text: string, tone: Tone = "dim") {
    return transcript.add({ type: "note", text, tone });
  }

  /** A message in the status bar that clears itself. */
  function flash(text: string, tone: Tone = "info", ms = 2500) {
    toast = text ? { text, tone } : null;
    clearTimeout(toastTimer);
    if (text)
      toastTimer = setTimeout(() => {
        toast = null;
        drawStatus();
      }, ms);
    drawStatus();
  }

  function setInput(value: string) {
    input.setText(value);
    input.gotoBufferEnd();
    onInputChange();
  }

  /** The cursor as an index into `input.plainText`. */
  function cursorIndex() {
    try {
      return input.editBuffer.cellOffsetToStringIndex(input.cursorOffset);
    } catch {
      return input.plainText.length;
    }
  }

  function setMode(mode: InputMode) {
    inputMode = mode;
    drawPrompt();
    drawStatus();
  }

  async function copy(value: string) {
    if (process.platform === "darwin") {
      const proc = Bun.spawn(["pbcopy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      proc.stdin.write(value);
      proc.stdin.end();
      if ((await proc.exited) === 0) return true;
    }
    return renderer.copyToClipboardOSC52(value);
  }

  function notify() {
    if (settings.notifications && !focused) process.stdout.write("\x07");
  }

  function setTitle() {
    const name = sessionTitle ? sessionTitle.split("\n")[0]!.slice(0, 60) : tildify(cwd);
    renderer.setTerminalTitle(`${busy ? G.diamond : G.model} ${name}`);
  }

  const modelName = () => (agent ? currentName(agent.configOptions, "model") : "");
  // What "auto" resolved to on the latest turn, read from Copilot's own session log.
  let routed = "";
  const isAuto = () => !!agent && selectOption(agent.configOptions, "model")?.currentValue === "auto";
  /** The model as shown: "auto → mai code 2 flash" once Copilot has routed a turn. */
  const modelLabel = () => (isAuto() && routed ? `${modelName()} ${G.arrow} ${routed}` : modelName()).toLowerCase();
  async function refreshRouted() {
    if (!agent || !isAuto()) return;
    const id = agent.sessionId;
    const found = await routedModel(id);
    if (id !== agent.sessionId || !found || found.name === routed) return;
    routed = found.name;
    drawStatus();
    drawSidebar();
  }
  const modeName = () => (agent ? currentName(agent.configOptions, "mode") : "");

  /** Whether the agent approves everything on its own: a permissions option set to on. */
  function yolo() {
    const o = agent && selectOption(agent.configOptions, "permissions");
    return !!o && /^(on|true|yes|allow)/i.test(String(o.currentValue));
  }

  function contextPct() {
    return usage?.size ? Math.round((usage.used / usage.size) * 100) : null;
  }

  // ── chrome ──────────────────────────────────────────────────────────────
  function sidebarShown() {
    return settings.sidebar && renderer.width >= SIDEBAR_MIN_WINDOW;
  }

  /** Applies the theme to everything outside the transcript. */
  function applyChrome() {
    const fill = settings.background ? th.bg : "transparent";
    renderer.setBackgroundColor(fill);
    root.backgroundColor = fill;
    sidebar.borderColor = th.separator;
    completions.backgroundColor = settings.background ? th.bg : "transparent";
    input.textColor = th.fg;
    input.focusedTextColor = th.fg;
    input.placeholderColor = th.fgFaint;
    input.cursorColor = th.mono ? th.fg : th.secondary;
    input.selectionBg = th.primary;
    input.selectionFg = th.onPrimary;
    queued.fg = th.fgMuted;
    layout();
  }

  function layout() {
    const side = sidebarShown();
    sidebar.visible = side;
    drawSidebar();
    drawPrompt();
    drawTodos();
    drawHelp();
    drawStatus();
  }

  function drawPrompt() {
    // fx's prompt is a bright rail beside the text; shell and note modes swap it for $ and #.
    const rows = Math.max(1, input.height);
    const rail = inputMode === "bash" ? "$" : inputMode === "memory" ? "#" : G.rail;
    const color = inputMode === "prompt" ? th.fg : th.fgMuted;
    promptMark.content = styled(fg(color)(rail), fg(th.fgFaint)(("\n" + (inputMode === "prompt" ? G.rail : " ")).repeat(rows - 1)));
    input.placeholder =
      inputMode === "bash"
        ? "Run a shell command"
        : inputMode === "memory"
          ? "Add a note to your instructions"
          : "";
  }

  function modeColor(mode: string) {
    const m = mode.toLowerCase();
    return m.includes("plan") ? th.plan : m.includes("auto") ? th.yolo : th.fg;
  }

  function drawSidebar() {
    if (!sidebar.visible) return;
    const w = SIDEBAR_WIDTH - 3;
    const parts: (TextChunk | string)[] = [];
    const line = (...c: (TextChunk | string)[]) => parts.push(...c, "\n");
    const section = (name: string) => {
      parts.push("\n");
      line(bold(fg(th.fgSubtle)(name)), fg(th.separator)(" " + G.rule.repeat(Math.max(0, w - name.length - 1))));
    };

    line(...hatchedTitle(th, "btr", w));
    parts.push("\n");
    line(bold(fg(th.fg)(trunc((sessionTitle || "New Session").split("\n")[0]!, w))));
    line(fg(th.fgMuted)(truncStart(tildify(cwd), w)));

    section("Model");
    line(fg(th.primary)(`${G.model} `), fg(th.fg)(trunc(modelLabel() || "unknown", w - 2)));
    const mode = modeName();
    if (mode) line(fg(th.fgMuted)("  mode "), fg(modeColor(mode))(mode));
    const pct = contextPct();
    if (pct !== null && usage) {
      const barW = w - 2;
      const filled = Math.max(0, Math.min(barW, Math.round((pct / 100) * barW)));
      line("  ", fg(pct >= 80 ? th.warning : th.primary)("━".repeat(filled)), fg(th.separator)("━".repeat(barW - filled)));
      line(fg(th.fgMuted)(`  ${pct}% · ${formatTokens(usage.used)} / ${formatTokens(usage.size)} tokens`));
      if (usage.cost) line(fg(th.fgMuted)(`  ${usage.cost.amount.toFixed(4)} ${usage.cost.currency}`));
    }

    section("Modified Files");
    const files = new Map<string, { added: number; removed: number }>();
    for (const list of changes.values())
      for (const c of list) {
        const f = files.get(c.path) ?? { added: 0, removed: 0 };
        f.added += c.added;
        f.removed += c.removed;
        files.set(c.path, f);
      }
    if (!files.size) line(fg(th.fgFaint)("None"));
    for (const [path, f] of [...files].slice(0, 12)) {
      const stats = ` +${f.added} -${f.removed}`;
      line(fg(th.fgSubtle)(truncStart(path, w - stats.length)), fg(th.success)(` +${f.added}`), fg(th.error)(` -${f.removed}`));
    }
    if (files.size > 12) line(fg(th.fgFaint)(`${files.size - 12} more`));

    if (plan.length) {
      section("To-Dos");
      for (const e of plan.slice(0, 10)) line(...todoLine(th, { ...e, content: trunc(e.content, w - 2) }).chunks);
    }

    section("Permissions");
    line(yolo() ? bold(fg(th.yolo)("full access")) : fg(th.fgMuted)("ask before tools"), fg(th.fgFaint)("  ctrl+y"));
    sidebarText.content = styled(...parts);
  }

  /**
   * The line under the prompt, fx's statusline: permissions, model, mode and context,
   * joined by " · ". A flash takes its place for a moment.
   */
  function drawStatus() {
    status.visible = !showHelp;
    statusRight.content = "";
    if (toast) {
      const color = toast.tone === "dim" || toast.tone === "info" ? th.fgSubtle : toneColor(th, toast.tone);
      statusLeft.content = styled(fg(color)(toneGlyph(toast.tone) + toast.text));
      return;
    }
    if (disconnected) {
      statusLeft.content = styled(fg(th.error)(`${G.fail} agent disconnected · restart btr to continue`));
      return;
    }
    if (inputMode !== "prompt") {
      statusLeft.content = styled(fg(th.fgMuted)(`${inputMode === "bash" ? "shell" : "note"} mode · enter ${inputMode === "bash" ? "runs" : "saves"} · esc leaves`));
      return;
    }
    const parts: TextChunk[][] = [];
    parts.push([yolo() ? fg(th.fg)("full access") : fg(th.fgMuted)("ask")]);
    if (!agent?.sessionId) parts.push([fg(th.fgMuted)(`connecting${G.ellipsis}`)]);
    if (modelName()) parts.push([fg(th.fgMuted)(modelLabel())]);
    const modeOption = agent && selectOption(agent.configOptions, "mode");
    const mode = modeName();
    if (modeOption && mode && choices(modeOption)[0]?.name !== mode) parts.push([fg(th.fg)(mode.toLowerCase())]);
    const pct = contextPct();
    if (usage?.size && pct !== null) parts.push([fg(pct >= 80 ? th.warning : th.fgMuted)(`${formatTokens(usage.used)}/${formatTokens(usage.size)} ${pct}%`)]);
    if (settings.verbose) parts.push([fg(th.fgMuted)("details")]);
    if (stash !== null) parts.push([fg(th.fgMuted)("stashed")]);
    statusLeft.content = styled(...parts.flatMap((p, i) => (i ? [fg(th.fgFaint)(" · "), ...p] : p)));
  }

  function drawHelp() {
    helpPanel.visible = showHelp;
    if (!showHelp) return;
    const cols: [string, string][][] = [
      [["ctrl+p", "commands"], ["/", "commands (empty prompt)"], ["@", "mention a file"], ["!", "shell mode"], ["#", "save a note"], ["shift+enter", "newline"]],
      [["ctrl+n", "new session"], ["ctrl+s", "sessions"], ["ctrl+l", "switch model"], ["shift+tab", "cycle mode"], ["ctrl+y", "yolo mode"], ["esc", "interrupt"]],
      [["ctrl+d", "toggle details"], ["ctrl+b", "toggle sidebar"], ["ctrl+t", "pin to-dos"], ["ctrl+o", "open $EDITOR"], ["ctrl+r", "search history"], ["ctrl+v", "paste image"]],
    ];
    // Three columns when they fit, else one after another.
    const colWidth = Math.floor((renderer.width - 4) / 3);
    const descWidth = colWidth - 12;
    const grid = descWidth >= 14 ? cols : [cols.flat()];
    const rows: (TextChunk | string)[] = [];
    for (let r = 0; r < grid[0]!.length; r++) {
      if (r) rows.push("\n");
      for (const col of grid) {
        const [k, d] = col[r]!;
        rows.push(bold(fg(th.fgSubtle)(k.padEnd(12))), fg(th.fgMuted)(grid.length > 1 ? trunc(d, descWidth - 1).padEnd(descWidth) : d));
      }
    }
    rows.push("\n\n", fg(th.fgFaint)("ctrl+g to close · alt+s stash · ctrl+c twice to quit · pgup/pgdn scroll"));
    helpPanel.content = styled(...rows);
  }

  function drawTodos() {
    const visible = showTodos && plan.length > 0;
    todoPanel.visible = visible;
    if (!visible) return;
    const done = plan.filter((e) => e.status === "completed").length;
    const parts: (TextChunk | string)[] = [bold(fg(th.fg)("To-Dos")), fg(th.fgMuted)(`  ${done}/${plan.length}`)];
    for (const e of plan) parts.push("\n ", ...todoLine(th, e).chunks);
    todoPanel.content = styled(...parts);
  }

  function drawQueue() {
    queued.visible = queue.length > 0;
    queued.content = styled(
      ...queue.flatMap((q, i) => [i ? "\n" : "", fg(th.fgFaint)(`${G.thick} queued `), fg(th.fgMuted)(trunc(q.replace(/\n/g, " ⏎ "), 80))]),
    );
  }

  function setTheme() {
    th = resolveTheme();
    syntax = syntaxStyleFor(th, renderer.nativeScene);
    glowSyntax = glowSyntaxStyle(glowPalettes[th.name], renderer.nativeScene);
    applyChrome();
    transcript.rebuild();
    menus.refresh();
    drawCompletions();
    drawSpinner();
  }

  // ── working indicator ───────────────────────────────────────────────────
  let spinTimer: ReturnType<typeof setInterval> | undefined;
  let spinTick = 0;

  /** fx's working line: "• Generating (12s) (↓1.2k)", a light sweeping across the label. */
  function drawSpinner() {
    const visible = busy && !!turn && !menus.active;
    spinner.visible = visible;
    if (!visible || !turn) return;
    const active = plan.find((e) => e.status === "in_progress")?.content;
    const label = trunc(active ?? turn.label, 60);
    const chars = [...label];
    // A band of light a few characters wide passes over the label, then rests.
    const period = chars.length + 16;
    const at = (spinTick % period) - 4;
    const shimmer = chars.map((ch, i) => fg(blend(th.fg, th.fgFaint, Math.min(1, Math.abs(i - at) / 4)))(ch));
    const info = [`(${formatDuration(Date.now() - turn.since)})`];
    const tokens = Math.round(turn.chars / 4);
    if (tokens > 0) info.push(`(↓${formatTokens(tokens)})`);
    const blink = Math.floor(spinTick / 8) % 2 === 0;
    spinner.content = styled(fg(blink ? th.fg : th.fgFaint)(`${G.pending} `), ...shimmer, fg(th.fgFaint)(` ${info.join(" ")}`));
  }

  function startSpinner() {
    spinTick = 0;
    clearInterval(spinTimer);
    spinTimer = setInterval(() => {
      spinTick++;
      drawSpinner();
      if (spinTick % 8 === 0) transcript.tick();
    }, 60);
    drawSpinner();
  }

  function stopSpinner() {
    clearInterval(spinTimer);
    spinTimer = undefined;
    drawSpinner();
  }

  function setLabel(label: string) {
    if (turn) turn.label = label;
  }

  // ── transcript state ────────────────────────────────────────────────────
  type ReplyEntry = Entry<Extract<Item, { type: "assistant" }>>;
  type ThoughtEntry = Entry<Extract<Item, { type: "thought" }>>;
  type ToolEntry = Entry<Extract<Item, { type: "tool" }>>;
  type PlanEntry = Entry<Extract<Item, { type: "plan" }>>;
  type UserEntry = Entry<Extract<Item, { type: "user" }>>;
  const cur: { reply?: ReplyEntry; thought?: ThoughtEntry; plan?: PlanEntry; user?: UserEntry } = {};
  const tools = new Map<string, ToolEntry>();

  function endReply() {
    if (cur.reply) transcript.finishReply(cur.reply);
    cur.reply = undefined;
  }

  function endThought() {
    if (!cur.thought) return;
    cur.thought.item.ms = Date.now() - cur.thought.item.since;
    transcript.update(cur.thought);
    cur.thought = undefined;
  }

  function endBlocks() {
    endReply();
    endThought();
    cur.user = undefined;
  }

  /** The welcome line, as fx prints it: "btr v0.2.0 · / for commands". */
  function splash(): Extract<Item, { type: "splash" }> {
    return { type: "splash", name: "btr", detail: `v${VERSION} · / for commands` };
  }

  function refreshSplash() {
    const first = transcript.entries[0];
    if (first?.item.type !== "splash") return;
    Object.assign(first.item, splash());
    transcript.update(first);
  }

  function resetTranscript() {
    routed = "";
    transcript.clear();
    tools.clear();
    changes.clear();
    cur.reply = cur.thought = cur.plan = cur.user = undefined;
    plan = [];
    usage = null;
    sessionTitle = "";
    transcript.add(splash());
    layout();
    setTitle();
  }

  const contentText = (c: acp.ContentBlock) =>
    c.type === "text" ? c.text : c.type === "resource_link" ? `@${shortPath(cwd, c.uri.replace(/^file:\/\//, ""))} ` : c.type === "image" ? "[Image] " : "";

  function recordChanges(tool: ToolState) {
    const list = toolFileChanges(tool, cwd);
    if (!list.length) return;
    changes.set(tool.id, list);
    drawSidebar();
  }

  function onUpdate(u: acp.SessionUpdate) {
    switch (u.sessionUpdate) {
      case "user_message_chunk": {
        // Only a loaded session replays user messages.
        const t = contentText(u.content);
        if (!t) return;
        endReply();
        endThought();
        if (cur.user) {
          cur.user.item.text += t;
          transcript.update(cur.user);
        } else cur.user = transcript.add({ type: "user", text: t, mode: "prompt" });
        return;
      }
      case "agent_message_chunk": {
        const t = contentText(u.content);
        if (!t) return;
        endThought();
        cur.user = undefined;
        if (turn) turn.chars += t.length;
        setLabel("Generating");
        if (!cur.reply) cur.reply = transcript.add({ type: "assistant", text: "", streaming: !replaying });
        transcript.append(cur.reply, t);
        return;
      }
      case "agent_thought_chunk": {
        const t = contentText(u.content);
        if (!t) return;
        // Reply text after this thought starts a new block below it.
        endReply();
        cur.user = undefined;
        if (turn) turn.chars += t.length;
        setLabel("Thinking");
        if (!cur.thought) cur.thought = transcript.add({ type: "thought", text: "", since: Date.now(), ms: replaying ? 0 : undefined });
        cur.thought.item.text += t;
        transcript.update(cur.thought);
        return;
      }
      case "tool_call": {
        endBlocks();
        const tool: ToolState = {
          id: u.toolCallId,
          title: u.title,
          kind: u.kind,
          status: u.status ?? "pending",
          rawInput: u.rawInput,
          rawOutput: u.rawOutput,
          content: u.content ?? [],
          locations: u.locations ?? [],
        };
        setLabel("Running");
        const existing = tools.get(u.toolCallId);
        if (existing) {
          existing.item.tool = tool;
          transcript.update(existing);
        } else tools.set(u.toolCallId, transcript.add({ type: "tool", tool }));
        recordChanges(tool);
        return;
      }
      case "tool_call_update": {
        const entry = tools.get(u.toolCallId);
        if (!entry) return;
        const tool = entry.item.tool;
        if (u.title) tool.title = u.title;
        if (u.kind) tool.kind = u.kind;
        if (u.status) tool.status = u.status;
        if (u.content) tool.content = u.content;
        if (u.locations) tool.locations = u.locations;
        if (u.rawInput !== undefined) tool.rawInput = u.rawInput;
        if (u.rawOutput !== undefined) tool.rawOutput = u.rawOutput;
        if (u.status === "completed" || u.status === "failed") setLabel("Working");
        transcript.update(entry);
        recordChanges(tool);
        return;
      }
      case "plan": {
        endBlocks();
        plan = u.entries;
        // The agent resends the whole plan on every change: keep one block per turn.
        if (cur.plan) {
          cur.plan.item.entries = u.entries;
          transcript.update(cur.plan);
        } else cur.plan = transcript.add({ type: "plan", entries: u.entries });
        drawTodos();
        drawSidebar();
        return;
      }
      case "available_commands_update":
        commands = u.availableCommands;
        return;
      case "config_option_update":
        if (agent) agent.configOptions = u.configOptions;
        layout();
        return;
      case "current_mode_update": {
        const mode = agent && selectOption(agent.configOptions, "mode");
        if (mode) mode.currentValue = u.currentModeId;
        layout();
        return;
      }
      case "session_info_update":
        if (u.title) sessionTitle = u.title;
        setTitle();
        drawSidebar();
        return;
      case "usage_update":
        usage = u;
        void refreshRouted();
        drawSidebar();
        drawStatus();
        return;
      case "notice":
        endBlocks();
        note([u.title, u.description].filter(Boolean).join(": "), u.severity === "error" ? "error" : u.severity === "warning" ? "warning" : "dim");
        return;
      case "compaction_update":
        endBlocks();
        if (u.status === "in_progress") note(`Compacting the conversation${G.ellipsis}`);
        else if (u.status === "completed") note("Conversation compacted", "success");
        else note(`Compaction ${u.status}${u.error ? `: ${u.error}` : ""}`, "warning");
        return;
    }
  }

  // ── permissions ─────────────────────────────────────────────────────────
  const PERMISSION_KEYS: Record<string, [string, string]> = {
    allow_once: ["a", "allow"],
    allow_always: ["s", "allow for session"],
    reject_once: ["d", "deny"],
    reject_always: ["f", "always deny"],
  };

  async function onPermission(req: acp.RequestPermissionRequest): Promise<acp.RequestPermissionOutcome> {
    const known = tools.get(req.toolCall.toolCallId)?.item.tool;
    const tool: ToolState = {
      id: req.toolCall.toolCallId,
      title: req.toolCall.title ?? known?.title ?? "Tool call",
      kind: req.toolCall.kind ?? known?.kind,
      status: "pending",
      rawInput: req.toolCall.rawInput ?? known?.rawInput,
      content: req.toolCall.content ?? known?.content ?? [],
      locations: req.toolCall.locations ?? known?.locations ?? [],
    };
    const { name, arg } = toolHeader(tool, cwd);
    const patches = toolPatches(tool, cwd);
    setLabel("Waiting for approval");
    notify();
    const used = new Set<string>();
    const optionId = await menus.open({
      title: PERMISSION_TITLE,
      buttons: true,
      body: () => {
        // What fx shows above its choices: what the tool wants and why, then the command or the diff.
        const nodes: Renderable[] = [];
        const line = (...parts: (TextChunk | string)[]) =>
          new TextRenderable(renderer, { content: styled(...parts), flexShrink: 0, wrapMode: "word" });
        const reason = tool.title && tool.title !== arg && !tool.title.endsWith(arg) ? tool.title : "";
        if (tool.kind === "execute") {
          nodes.push(line(fg(th.fg)(`Run a command in ${tildify(cwd)}`), reason ? fg(th.fgMuted)(` · ${reason}`) : ""));
          const cmd = new BoxRenderable(renderer, { flexShrink: 0, marginTop: 1 });
          cmd.add(new TextRenderable(renderer, { content: styled(fg(th.fgMuted)("$ "), fg(th.fg)(arg)), flexShrink: 1 }));
          nodes.push(cmd);
        } else {
          nodes.push(line(fg(th.fg)(toolVerb(name, "pending")), arg ? fg(th.fgSubtle)(" " + arg) : "", reason ? fg(th.fgMuted)(` · ${reason}`) : ""));
          for (const p of patches) {
            const d = transcript.diffView(p);
            d.marginTop = 1;
            nodes.push(d);
          }
        }
        return nodes;
      },
      options: req.options.map((o) => {
        const known = PERMISSION_KEYS[o.kind];
        const key = known && !used.has(known[0]) ? known[0] : undefined;
        if (key) used.add(key);
        return { label: o.name, value: o.optionId, key, short: known?.[1] };
      }),
    });
    setLabel("Working");
    return optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" };
  }

  // ── turns ───────────────────────────────────────────────────────────────
  async function send(prompt: string) {
    if (disconnected) return void note("The agent is not connected.", "error");
    const asked = transcript.add({ type: "user", text: prompt, mode: "prompt" });
    cur.reply = cur.thought = cur.plan = cur.user = undefined;
    busy = true;
    turns++;
    const connected = !!agent?.sessionId;
    turn = { since: Date.now(), chars: 0, label: connected ? "Thinking" : "Connecting", cancelled: false };
    drawPrompt();
    drawStatus();
    startSpinner();
    setTitle();
    let tone: Tone = "dim";
    let outcome = "";
    try {
      if (!connected) {
        await sessionReady;
        if (turn) turn.label = "Thinking";
      }
      if (!agent) throw new Error("The agent is not connected.");
      if (turn?.cancelled) return;
      const blocks = await attachments.blocks(prompt, cwd, !!agent.capabilities.promptCapabilities?.image);
      if (shellContext.length) blocks.unshift({ type: "text", text: shellContext.splice(0).join("\n\n") });
      // Copilot logs its routing choice a moment after the prompt lands.
      const peek = setTimeout(() => void refreshRouted(), 800);
      const res = await agent.prompt(blocks).finally(() => clearTimeout(peek));
      await refreshRouted();
      endBlocks();
      if (res.stopReason === "cancelled") {
        outcome = "interrupted";
        tone = "warning";
      } else if (res.stopReason !== "end_turn") {
        outcome = `stopped: ${res.stopReason.replace(/_/g, " ")}`;
        tone = "warning";
      }
    } catch (err: any) {
      endBlocks();
      note(String(err?.message ?? err), "error");
      outcome = "failed";
      tone = "error";
    } finally {
      const cancelled = turn?.cancelled;
      const ms = turn ? Date.now() - turn.since : 0;
      busy = false;
      turn = null;
      stopSpinner();
      transcript.tick();
      // Calls the agent never finished stop blinking and read as abandoned.
      for (const e of tools.values()) if (e.item.tool.status === "pending" || e.item.tool.status === "in_progress") transcript.update(e);
      if (!cancelled && !outcome) foldTurn(asked);
      if (cancelled) transcript.add({ type: "footer", text: `${G.stop} Cancelled · What should the agent do differently?`, tone: "text" });
      else transcript.add({ type: "footer", text: [outcome ? `${outcome} after ${formatDuration(ms)}` : `Worked for ${formatDuration(ms)}`, modelLabel()].filter(Boolean).join(" · "), tone });
      setTitle();
      drawPrompt();
      drawStatus();
      notify();
      if (queue.length) {
        const next = queue.splice(0);
        drawQueue();
        // An interrupted turn hands queued messages back for editing rather than sending them.
        if (cancelled) setInput([...next, input.plainText].filter(Boolean).join("\n"));
        else void send(next.join("\n\n"));
      }
    }
  }

  /**
   * Once a turn ends, its thinking, tool calls and in-between messages fold into one line,
   * so the reply that closes it stands on its own. Errors and warnings stay in view.
   */
  function foldTurn(asked: Entry) {
    const after = transcript.entries.slice(transcript.entries.indexOf(asked) + 1);
    let last = -1;
    for (let i = after.length - 1; i >= 0; i--) {
      const it = after[i]!.item;
      if (it.type === "assistant" && it.text.trim()) {
        last = i;
        break;
      }
    }
    if (last <= 0) return;
    const members = after.slice(0, last).filter((e) => !(e.item.type === "note" && (e.item.tone === "error" || e.item.tone === "warning")));
    if (members.some((e) => e.item.type === "tool" || e.item.type === "thought")) transcript.fold(members);
  }

  function interrupt() {
    if (!busy) return;
    if (turn) turn.cancelled = true;
    menus.cancelAll();
    // A prompt still waiting for the session never reached the agent; send() drops it once ready.
    if (agent?.sessionId) agent.cancel();
  }

  // ── shell and memory modes ──────────────────────────────────────────────
  async function runShell(command: string) {
    const entry: UserEntry = transcript.add({ type: "user", text: command, mode: "bash", result: { text: `Running${G.ellipsis}` } });
    let output = "";
    let dirty = false;
    const paint = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      entry.item.result = { text: Bun.stripANSI(output).trimEnd() || `Running${G.ellipsis}` };
      transcript.update(entry);
    }, 120);
    try {
      const proc = Bun.spawn([process.env.SHELL ?? "sh", "-c", command], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      shell = proc;
      const read = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
          output += decoder.decode(chunk, { stream: true });
          dirty = true;
        }
      };
      await Promise.all([read(proc.stdout), read(proc.stderr)]);
      const code = await proc.exited;
      // Escape sequences in command output would corrupt the layout.
      output = Bun.stripANSI(output).trimEnd();
      entry.item.result = { text: output || "(no output)", tone: code === 0 ? "dim" : "error" };
      shellContext.push(`I ran this shell command myself:\n$ ${command}\n${output.slice(0, 20000) || "(no output)"}${code ? `\n(exit code ${code})` : ""}`);
    } catch (err: any) {
      entry.item.result = { text: String(err?.message ?? err), tone: "error" };
    } finally {
      clearInterval(paint);
      shell = null;
      transcript.update(entry);
    }
  }

  async function addMemory(memo: string) {
    const targets: MenuOption[] = [
      { label: "Project instructions", value: join(cwd, "AGENTS.md"), hint: "AGENTS.md" },
      { label: "Project Copilot instructions", value: join(cwd, ".github", "copilot-instructions.md"), hint: ".github/copilot-instructions.md" },
      { label: "User instructions", value: join(homedir(), ".copilot", "copilot-instructions.md"), hint: "~/.copilot/…" },
    ];
    const file = await menus.open({ title: "Save Note", question: `Where should "${trunc(memo, 50)}" be saved?`, options: targets });
    if (!file) return;
    try {
      await mkdir(dirname(file), { recursive: true });
      const existing = (await Bun.file(file).exists()) ? await Bun.file(file).text() : "";
      await appendFile(file, `${existing && !existing.endsWith("\n") ? "\n" : ""}- ${memo}\n`);
      transcript.add({ type: "user", text: memo, mode: "memory", result: { text: `Saved to ${tildify(file)}` } });
    } catch (err: any) {
      note(`Could not save the note: ${err?.message ?? err}`, "error");
    }
  }

  // ── options: mode, model, yolo ──────────────────────────────────────────
  async function setOption(category: string, value: string) {
    const o = agent && selectOption(agent.configOptions, category);
    if (!agent || !o || o.currentValue === value) return;
    try {
      await agent.setConfigOption(o.id, value);
    } catch (err: any) {
      flash(`Could not set ${category}: ${err?.message ?? err}`, "error");
    }
    layout();
  }

  /** Sets a select option from what the user typed: a value, a name, or the start of one. */
  async function setOptionByName(category: string, wanted: string): Promise<boolean> {
    const o = agent && selectOption(agent.configOptions, category);
    if (!o) return false;
    const w = wanted.toLowerCase();
    const list = choices(o);
    const match =
      list.find((c) => c.value.toLowerCase() === w || c.name.toLowerCase() === w) ??
      list.find((c) => c.name.toLowerCase().startsWith(w) || c.value.toLowerCase().includes(w));
    if (!match) return false;
    await setOption(category, match.value);
    return true;
  }

  function cycleMode() {
    const o = agent && selectOption(agent.configOptions, "mode");
    if (!o) return flash("This agent has no modes", "warning");
    const list = choices(o);
    const i = list.findIndex((c) => c.value === o.currentValue);
    void setOption("mode", list[(i + 1) % list.length]!.value);
  }

  async function pickOption(category: "model" | "mode") {
    const o = agent && selectOption(agent.configOptions, category);
    if (!o) return flash(`This agent has no ${category} option`, "warning");
    const list = choices(o);
    const value = await menus.open({
      title: category === "model" ? "Switch Model" : "Switch Mode",
      options: list.map((c) => ({ label: c.name, value: c.value, hint: c.value === o.currentValue ? G.check : undefined })),
      initial: list.findIndex((c) => c.value === o.currentValue),
      filterable: true,
      placeholder: category === "model" ? "Choose a model" : "Choose a mode",
    });
    if (!value) return;
    await setOption(category, value);
    flash(`${category === "model" ? "Model" : "Mode"}: ${currentName(agent!.configOptions, category)}`, "success");
  }

  async function toggleYolo() {
    const o = agent && selectOption(agent.configOptions, "permissions");
    if (!o) return flash("This agent has no allow-all option", "warning");
    const list = choices(o);
    const on = list.find((c) => /^(on|true|yes|allow)/i.test(c.value));
    const off = list.find((c) => /^(off|false|no|ask)/i.test(c.value));
    if (!on || !off) {
      const value = await menus.open({ title: o.name, options: list.map((c) => ({ label: c.name, value: c.value })) });
      if (value) await setOption("permissions", value);
      return;
    }
    await setOption("permissions", yolo() ? off.value : on.value);
    flash(yolo() ? "Yolo mode on: tools run without asking" : "Yolo mode off: tools ask first", yolo() ? "warning" : "info");
  }

  // ── sessions ────────────────────────────────────────────────────────────
  async function loadSession(id: string, title = "") {
    if (!agent) return;
    resetTranscript();
    replaying = true;
    try {
      await agent.loadSession(id);
      endBlocks();
      sessionTitle ||= title;
      note(`Resumed ${trunc((sessionTitle || id).split("\n")[0]!, 60)}`);
    } catch (err: any) {
      endBlocks();
      note(`Could not resume ${id}: ${err?.message ?? err}`, "error");
      if (!agent.sessionId) await agent.newSession();
    } finally {
      replaying = false;
      cur.plan = undefined;
      void refreshRouted();
      refreshSplash();
      layout();
      setTitle();
    }
  }

  async function newSession() {
    if (busy) return flash("Wait for the turn to end, or press esc to interrupt it", "warning");
    if (!agent) return;
    await agent.newSession();
    resetTranscript();
    refreshSplash();
    flash("New session", "success", 1500);
  }

  const ago = (iso?: string | null) => {
    if (!iso) return "";
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 90) return "just now";
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  };

  /** Shows the session list; resolves false when nothing was loaded. */
  async function pickSession(): Promise<boolean> {
    if (!agent) return false;
    if (busy) return (flash("Wait for the turn to end, or press esc to interrupt it", "warning"), false);
    if (!agent.capabilities.loadSession) return (flash("This agent cannot resume sessions", "warning"), false);
    const sessions = (await agent.listSessions().catch(() => [])).filter((s) => s.sessionId !== agent!.sessionId);
    if (!sessions.length) return (flash("No earlier sessions for this directory"), false);
    const id = await menus.open({
      title: "Sessions",
      options: sessions.map((s) => ({ label: (s.title ?? s.sessionId).split("\n")[0]!.slice(0, 80), value: s.sessionId, hint: ago(s.updatedAt) })),
      filterable: true,
      placeholder: "Search sessions",
      width: 90,
    });
    if (!id) return false;
    await loadSession(id, sessions.find((s) => s.sessionId === id)?.title ?? "");
    return true;
  }

  // ── actions: the palette and typed /commands ────────────────────────────
  const agentHas = (name: string) => commands.some((c) => c.name === name);

  const actions: Action[] = [
    { id: "new", label: "New Session", key: "ctrl+n", slash: ["new", "clear"], run: newSession },
    { id: "sessions", label: "Sessions", key: "ctrl+s", slash: ["sessions", "resume"], run: (args) => (args ? loadSession(args) : pickSession()) },
    {
      id: "model",
      label: "Switch Model",
      key: "ctrl+l",
      slash: ["model"],
      run: async (args) => {
        if (!args) return pickOption("model");
        if (await setOptionByName("model", args)) flash(`Model: ${modelName()}`, "success");
        else passToAgent(`/model ${args}`);
      },
    },
    {
      id: "mode",
      label: "Switch Mode",
      key: "shift+tab",
      slash: ["mode"],
      run: async (args) => {
        if (!args) return pickOption("mode");
        if (!(await setOptionByName("mode", args))) flash(`No mode matches "${args}"`, "warning");
      },
    },
    { id: "yolo", label: "Toggle Yolo Mode", key: "ctrl+y", slash: ["yolo"], run: toggleYolo },
    { id: "sidebar", label: "Toggle Sidebar", key: "ctrl+b", slash: ["sidebar"], run: toggleSidebar },
    { id: "details", label: "Toggle Details", key: "ctrl+d", slash: ["details", "verbose"], run: toggleVerbose },
    { id: "todos", label: "Toggle To-Dos", key: "ctrl+t", slash: ["todos"], run: toggleTodos },
    { id: "help", label: "Toggle Help", key: "ctrl+g", slash: ["keys"], run: toggleHelp },
    { id: "editor", label: "Open External Editor", key: "ctrl+o", slash: ["editor"], run: editExternally },
    { id: "history", label: "Search Prompt History", key: "ctrl+r", run: searchHistory },
    { id: "image", label: "Paste Image", key: "ctrl+v", run: pasteClipboardImage },
    { id: "stash", label: "Stash Prompt", key: "alt+s", run: toggleStash },
    { id: "copy", label: "Copy Last Reply", slash: ["copy"], run: copyLastReply },
    { id: "export", label: "Export Conversation", hint: "markdown", slash: ["export"], run: exportConversation },
    { id: "diff", label: "Show Git Diff", slash: ["diff"], run: showDiff },
    { id: "status", label: "Session Info", slash: ["status"], run: showStatus },
    { id: "cost", label: "Usage", slash: ["cost"], run: showCost },
    {
      id: "init",
      label: "Initialize Project",
      hint: "AGENTS.md",
      run: () => passToAgent(agentHas("init") ? "/init" : "Create an AGENTS.md describing this project's layout, build and test commands, and conventions."),
    },
    { id: "compact", label: "Compact Conversation", run: () => (agentHas("compact") ? passToAgent("/compact") : flash("This agent has no /compact", "warning")) },
    { id: "theme", label: "Themes", slash: ["theme"], run: pickTheme },
    { id: "background", label: "Toggle Background Color", run: toggleBackground },
    { id: "markdown", label: "Markdown Style", slash: ["markdown"], run: pickMarkdownStyle },
    { id: "notify", label: "Toggle Notifications", run: toggleNotifications },
    { id: "commands", label: "List Commands", slash: ["help"], run: showHelpBlock },
    { id: "login", label: "Sign In", slash: ["login"], run: showLogin },
    { id: "quit", label: "Quit", key: "ctrl+c", slash: ["quit", "exit"], run: quit },
  ];

  async function openPalette() {
    if (menus.active) return;
    const options: MenuOption[] = actions.map((a) => ({ label: a.label, value: `action:${a.id}`, hint: a.key ?? a.hint, tab: "System" }));
    for (const c of commands) {
      if (actions.some((a) => a.slash?.includes(c.name))) continue;
      options.push({ label: `/${c.name}`, value: `agent:${c.name}`, hint: trunc(c.description.split(/\.\s/)[0]!.replace(/\.$/, ""), 40), tab: "Agent" });
    }
    const value = await menus.open({
      title: "Commands",
      options,
      tabs: commands.length ? ["System", "Agent"] : undefined,
      filterable: true,
      placeholder: "Type a command",
      passthrough: true,
      width: 80,
    });
    if (!value) return;
    // "/name args": what was typed goes back to the prompt as a slash command to finish.
    if (value.startsWith("text:")) return setInput(`/${value.slice(5)}`);
    if (value.startsWith("space:")) {
      const picked = value.slice(6);
      const name = picked.startsWith("agent:") ? picked.slice(6) : actions.find((a) => a.id === picked.slice(7))?.slash?.[0];
      // A built-in without a slash name has no arguments to take: run it as Enter would.
      if (name) return setInput(`/${name} `);
      return void (await actions.find((a) => a.id === picked.slice(7))?.run(""));
    }
    if (value.startsWith("action:")) {
      const action = actions.find((a) => a.id === value.slice(7));
      try {
        await action?.run("");
      } catch (err: any) {
        flash(`${action?.label} failed: ${err?.message ?? err}`, "error");
      }
      return;
    }
    const name = value.slice(6);
    // Commands that take input go to the prompt to be finished; the rest run now.
    if (commands.find((c) => c.name === name)?.input) setInput(`/${name} `);
    else passToAgent(`/${name}`);
  }

  function showHelpBlock() {
    const own = actions.filter((a) => a.slash).map((a) => [`/${a.slash!.join(", /")}`, a.label + (a.key ? `  ${a.key}` : "")] as const);
    const theirs = commands.filter((c) => !actions.some((a) => a.slash?.includes(c.name)));
    const width = Math.max(...own.map(([k]) => k.length)) + 2;
    transcript.add({
      type: "block",
      text: styled(
        ...hatchedTitle(th, `btr ${VERSION}`, Math.min(60, renderer.width - 8)),
        "\n\n",
        ...own.flatMap(([k, d]) => [fg(th.primary)(k.padEnd(width)), fg(th.fgMuted)(d + "\n")]),
        "\n",
        fg(th.fgMuted)(
          theirs.length ? `${theirs.length} more come from the agent: ctrl+p, then tab to its list.\n` : "The agent's own commands appear in ctrl+p once it lists them.\n",
        ),
        fg(th.fgMuted)("ctrl+g shows every shortcut."),
      ),
    });
  }

  function infoBlock(title: string, rows: [string, string][], footer = "") {
    const width = Math.max(...rows.map(([k]) => k.length)) + 3;
    transcript.add({
      type: "block",
      text: styled(
        ...hatchedTitle(th, title, Math.min(60, renderer.width - 8)),
        "\n\n",
        ...rows.flatMap(([k, v]) => [fg(th.fgMuted)(k.padEnd(width)), fg(th.fg)(v + "\n")]),
        footer ? fg(th.fgFaint)(footer) : "",
      ),
    });
  }

  function showStatus() {
    const rows: [string, string][] = [];
    if (agent) {
      rows.push(["Agent", `${agent.info?.title ?? agent.info?.name ?? "unknown"} ${agent.info?.version ?? ""} (${agent.command})`]);
      rows.push(["Session", agent.sessionId || "none"]);
      for (const o of agent.configOptions) {
        if (o.type === "select") rows.push([o.name, choices(o).find((c) => c.value === o.currentValue)?.name ?? String(o.currentValue)]);
      }
    } else rows.push(["Agent", "not connected"]);
    rows.push(["Directory", tildify(cwd)]);
    if (usage?.size) rows.push(["Context", `${formatTokens(usage.used)} of ${formatTokens(usage.size)} tokens (${contextPct()}%)`]);
    rows.push(["Theme", `${settings.theme}${settings.theme === "auto" ? ` (${th.name})` : ""}`]);
    rows.push(["Settings", tildify(join(HOME, "config.json"))]);
    rows.push(["Agent log", AGENT_LOG]);
    infoBlock("Session Info", rows);
  }

  function showCost() {
    const rows: [string, string][] = [
      ["Duration", formatDuration(Date.now() - started)],
      ["Turns", String(turns)],
    ];
    if (usage?.size) rows.push(["Context", `${formatTokens(usage.used)} of ${formatTokens(usage.size)} tokens (${contextPct()}%)`]);
    if (usage?.cost) rows.push(["Cost", `${usage.cost.amount.toFixed(4)} ${usage.cost.currency}`]);
    infoBlock("Usage", rows, usage ? "" : agentHas("usage") ? "The agent has not reported usage yet; its /usage command asks it." : "The agent has not reported usage yet.");
  }

  async function copyLastReply() {
    const reply = transcript.lastReply();
    if (!reply) return flash("Nothing to copy yet");
    const ok = await copy(reply);
    flash(ok ? "Copied the last reply" : "Could not reach the clipboard", ok ? "success" : "error");
  }

  async function exportConversation(args: string) {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const file = resolve(cwd, args || `conversation-${stamp}.md`);
    try {
      await Bun.write(file, transcript.toMarkdown());
      flash(`Saved ${tildify(file)}`, "success", 4000);
    } catch (err: any) {
      flash(`Could not write ${file}: ${err?.message ?? err}`, "error");
    }
  }

  async function showDiff() {
    const proc = Bun.spawn(["git", "diff", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if ((await proc.exited) !== 0) return flash(err.trim().split("\n")[0] || "git diff failed", "warning");
    const files = out.split(/^(?=diff --git )/m).filter((f) => f.trim());
    if (!files.length) return flash("No uncommitted changes");
    for (const patch of files.slice(0, 30)) transcript.add({ type: "diff", patch });
    if (files.length > 30) note(`${files.length - 30} more files changed`);
  }

  async function pickTheme(args: string) {
    const names = ["auto", "fx", "fx-light", "charm", "daylight"];
    const value =
      args ||
      (await menus.open({
        title: "Themes",
        options: [
          { label: "Auto", value: "auto", hint: "fx, light or dark by the terminal" },
          { label: "fx", value: "fx", hint: "monochrome dark" },
          { label: "fx light", value: "fx-light", hint: "monochrome light" },
          { label: "Charm", value: "charm", hint: "dark" },
          { label: "Daylight", value: "daylight", hint: "light" },
        ],
        initial: names.indexOf(settings.theme),
      }));
    if (!value) return;
    if (!names.includes(value)) return flash(`Unknown theme "${value}"`, "warning");
    settings.theme = value as Settings["theme"];
    await saveSettings(settings);
    setTheme();
  }

  async function pickMarkdownStyle(args: string) {
    const value =
      args ||
      (await menus.open({
        title: "Markdown Style",
        options: [
          { label: "Glow", value: "glow", hint: "glow's colors and headings" },
          { label: "btr", value: "btr", hint: "the theme's colors" },
        ],
        initial: settings.markdown === "glow" ? 0 : 1,
      }));
    if (!value) return;
    if (value !== "glow" && value !== "btr") return flash(`Unknown markdown style "${value}"`, "warning");
    settings.markdown = value;
    await saveSettings(settings);
    transcript.rebuild();
  }

  function toggleBackground() {
    settings.background = !settings.background;
    void saveSettings(settings);
    setTheme();
    flash(settings.background ? "Theme background on" : "Using the terminal's background");
  }

  function toggleNotifications() {
    settings.notifications = !settings.notifications;
    void saveSettings(settings);
    flash(`Notifications ${settings.notifications ? "on" : "off"}`);
  }

  function showLogin() {
    const methods = agent?.authMethods ?? [];
    note(methods.length ? methods.map((m) => `${m.name}${m.description ? `: ${m.description}` : ""}`).join("\n") : "This agent did not advertise a sign-in method.");
  }

  /** Details are for this run; nothing is saved. */
  function toggleVerbose() {
    settings.verbose = !settings.verbose;
    transcript.rebuild();
    drawStatus();
  }

  function toggleTodos() {
    showTodos = !showTodos;
    drawTodos();
    if (showTodos && !plan.length) flash("No to-dos yet");
  }

  function toggleSidebar() {
    settings.sidebar = !settings.sidebar;
    void saveSettings(settings);
    if (settings.sidebar && renderer.width < SIDEBAR_MIN_WINDOW) flash(`The sidebar needs a window at least ${SIDEBAR_MIN_WINDOW} columns wide`, "warning");
    layout();
  }

  function toggleHelp() {
    showHelp = !showHelp;
    drawHelp();
    drawStatus();
  }

  function toggleStash() {
    if (stash !== null && !input.plainText) {
      setInput(stash);
      stash = null;
    } else if (input.plainText) {
      stash = input.plainText;
      setInput("");
      flash("Prompt stashed · alt+s on an empty prompt restores it");
    } else flash("Nothing to stash");
    drawStatus();
  }

  function passToAgent(prompt: string) {
    if (busy) {
      queue.push(prompt);
      drawQueue();
    } else void send(prompt);
  }

  // ── @ completions ───────────────────────────────────────────────────────
  let matches: string[] = [];
  let selected = 0;
  let dismissed = false;

  function updateCompletions() {
    const mention = !dismissed && inputMode === "prompt" ? mentionAt(input.plainText, cursorIndex()) : null;
    matches = mention ? fuzzyFilter(mention.query, listFiles(cwd), (p) => p, 50) : [];
    selected = Math.min(selected, Math.max(0, matches.length - 1));
    drawCompletions();
  }

  function drawCompletions() {
    const open = matches.length > 0 && !menus.active;
    completions.visible = open;
    if (!open) return;
    const start = Math.max(0, Math.min(selected - Math.floor(MAX_COMPLETIONS / 2), matches.length - MAX_COMPLETIONS));
    const width = Math.min(70, Math.max(24, ...matches.slice(start, start + MAX_COMPLETIONS).map((m) => m.length + 4)));
    completions.width = width + 2;
    completionRows.forEach((row, i) => {
      const m = matches[start + i];
      row.visible = !!m;
      if (!m) return;
      const on = start + i === selected;
      row.bg = settings.background ? th.bg : "transparent";
      row.content = styled(fg(th.fg)(on ? `${G.select} ` : "  "), (on ? (t: string) => bold(fg(th.fg)(t)) : fg(m.endsWith("/") ? th.fgSubtle : th.fgMuted))(truncStart(m, width - 4)));
    });
  }

  /** Replaces the `@partial` being typed with the selected path. */
  function completeMention() {
    const m = matches[selected];
    if (!m) return;
    const value = input.plainText;
    const at = cursorIndex();
    const mention = mentionAt(value, at);
    if (!mention) return;
    const insert = `@${/\s/.test(m) ? `"${m}"` : m}${m.endsWith("/") ? "" : " "}`;
    input.setText(value.slice(0, mention.start) + insert + value.slice(at));
    input.cursorOffset = input.editBuffer.stringIndexToCellOffset(mention.start + insert.length);
    onInputChange();
  }

  // ── input ───────────────────────────────────────────────────────────────
  let changing = false;

  /** Grows the prompt with its content, up to a dozen rows. */
  function fitInput() {
    const rows = Math.max(1, Math.min(12, Math.max(input.lineCount, input.virtualLineCount)));
    if (input.height !== rows) input.height = rows;
    drawPrompt();
  }

  function onInputChange() {
    if (changing) return;
    changing = true;
    try {
      const value = input.plainText;
      if (inputMode === "prompt" && (value === "!" || value === "#")) {
        // A lone `!` or `#` on an empty prompt switches mode instead of being typed.
        input.setText("");
        setMode(value === "!" ? "bash" : "memory");
      } else if (inputMode === "prompt" && value === "/") {
        // So does `/`: it opens the command palette.
        input.setText("");
        void openPalette();
      } else if (inputMode === "prompt" && value === "?") {
        input.setText("");
        toggleHelp();
      }
      fitInput();
      // Wrapping is only known after the next layout.
      setTimeout(fitInput, 0);
      dismissed = false;
      selected = 0;
      updateCompletions();
    } finally {
      changing = false;
    }
  }

  // TextareaRenderable reports edits and Enter through these callbacks; unlike
  // InputRenderable it never emits "input" or "enter" events.
  input.onContentChange = onInputChange;
  input.onCursorChange = () => {
    if (!changing && input.plainText.includes("@")) updateCompletions();
  };
  input.onSubmit = () => void submit();

  async function submit() {
    if (menus.active) return;
    const value = input.plainText.trim();
    if (!value) return;
    const mode = inputMode;
    input.setText("");
    if (mode !== "prompt") setMode("prompt");
    onInputChange();
    history.add(mode === "bash" ? `!${value}` : mode === "memory" ? `#${value}` : value);

    if (mode === "bash") return runShell(value);
    if (mode === "memory") return addMemory(value);

    if (value.startsWith("/")) {
      const [name = "", ...rest] = value.slice(1).split(/\s+/);
      const action = actions.find((a) => a.slash?.includes(name));
      if (action) {
        try {
          await action.run(rest.join(" "));
        } catch (err: any) {
          flash(`/${name} failed: ${err?.message ?? err}`, "error");
        }
        return;
      }
      if (!agentHas(name) && /^\/[\w-]+$/.test(value.split(/\s/)[0]!)) return flash(`Unknown command /${name} · ctrl+p lists them`, "warning");
    }
    if (disconnected) return flash("The agent is disconnected; restart btr to continue", "error");
    if (busy) {
      queue.push(value);
      return drawQueue();
    }
    await send(value);
  }

  /** Puts a history entry in the prompt, restoring the mode it was typed in. */
  function recall(entry: string) {
    const mode: InputMode = entry.startsWith("!") ? "bash" : entry.startsWith("#") ? "memory" : "prompt";
    if (mode !== inputMode) setMode(mode);
    // Set directly: a recalled "/" or "!" must not switch modes again.
    changing = true;
    input.setText(mode === "prompt" ? entry : entry.slice(1));
    input.gotoBufferEnd();
    changing = false;
    fitInput();
    setTimeout(fitInput, 0);
    matches = [];
    drawCompletions();
  }

  async function searchHistory() {
    const all = history.all();
    if (!all.length) return flash("No prompt history yet");
    const value = await menus.open({
      title: "Prompt History",
      options: all.map((h, i) => ({ label: h.replace(/\s*\n\s*/g, " ⏎ ").slice(0, 100), value: String(i) })),
      filterable: true,
      placeholder: "Search history",
      width: 90,
    });
    if (value !== null) recall(all[Number(value)]!);
  }

  async function editExternally() {
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
    const file = join(tmpdir(), `btr-prompt-${process.pid}.md`);
    await Bun.write(file, input.plainText);
    await renderer.suspend();
    try {
      await Bun.spawn([...editor.split(" ").filter(Boolean), file], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
    } catch {
      // A missing editor leaves the prompt as it was.
    }
    await renderer.resume();
    try {
      setInput((await Bun.file(file).text()).replace(/\n+$/, ""));
      await Bun.file(file).delete();
    } catch {
      // The editor removed the file: keep the prompt.
    }
    input.focus();
  }

  async function suspendProcess() {
    await renderer.suspend();
    process.once("SIGCONT", () => {
      void renderer.resume().then(() => input.focus());
    });
    process.kill(process.pid, "SIGTSTP");
  }

  async function pasteClipboardImage() {
    const placeholder = await attachments.imageFromClipboard();
    if (placeholder) input.insertText(placeholder + " ");
    else flash("No image on the clipboard", "warning");
  }

  renderer.keyInput.on("paste", (event) => {
    event.preventDefault();
    if (menus.active) return;
    const pasted = new TextDecoder().decode(event.bytes).replace(/\r\n?/g, "\n");
    void (async () => {
      const image = await attachments.imageFromPath(pasted);
      input.insertText(image ? image + " " : attachments.paste(pasted));
    })();
  });

  // ── keys ────────────────────────────────────────────────────────────────
  function quit() {
    clearInterval(spinTimer);
    shell?.kill();
    agent?.stop();
    renderer.destroy();
    process.exit(0);
  }

  /** True when the cursor is on the first (or last) row of the prompt, so ↑/↓ leave it for history. */
  function atEdge(edge: "top" | "bottom") {
    const rows = input.virtualLineCount;
    if (rows <= 1) return true;
    const row = input.visualCursor.visualRow + input.scrollY;
    return edge === "top" ? row <= 0 : row >= rows - 1;
  }

  /** Ctrl shortcuts, which work whatever is typed. */
  const ctrlKeys: Record<string, () => unknown> = {
    p: openPalette,
    n: newSession,
    s: pickSession,
    l: () => pickOption("model"),
    y: toggleYolo,
    b: toggleSidebar,
    d: toggleVerbose,
    t: toggleTodos,
    g: toggleHelp,
    o: editExternally,
    r: searchHistory,
    v: pasteClipboardImage,
    z: suspendProcess,
  };

  function onKey(key: KeyEvent) {
    if (menus.active) {
      key.preventDefault();
      const permission = menus.current === PERMISSION_TITLE;
      // Dismissing a permission request declines it and stops the turn, as esc does anywhere else.
      if (menus.handleKey(key) === "cancel" && permission && busy) interrupt();
      return;
    }

    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (shell) return void shell.kill();
      if (input.plainText) {
        history.add(input.plainText);
        setInput("");
        if (inputMode !== "prompt") setMode("prompt");
        return;
      }
      if (busy) return interrupt();
      if (Date.now() - lastCtrlC < 1500) return quit();
      lastCtrlC = Date.now();
      return flash("Press ctrl+c again to quit", "warning", 1500);
    }

    if (key.name === "escape") {
      key.preventDefault();
      if (matches.length) {
        dismissed = true;
        return updateCompletions();
      }
      if (showHelp) return toggleHelp();
      if (shell) return void shell.kill();
      if (inputMode !== "prompt" && !input.plainText) return setMode("prompt");
      if (busy) return interrupt();
      if (input.plainText) {
        if (Date.now() - lastEsc < 800) {
          history.add(input.plainText);
          setInput("");
          if (inputMode !== "prompt") setMode("prompt");
          lastEsc = 0;
          return flash("");
        }
        lastEsc = Date.now();
        return flash("Esc again to clear the prompt", "info", 800);
      }
      return;
    }

    if (key.name === "tab" && key.shift) {
      key.preventDefault();
      return cycleMode();
    }
    if (key.name === "tab") {
      key.preventDefault();
      if (matches.length) completeMention();
      return;
    }

    if (key.name === "backspace" && !input.plainText && inputMode !== "prompt") {
      key.preventDefault();
      return setMode("prompt");
    }

    const plainEnter = (key.name === "return" || key.name === "kpenter") && !key.shift && !key.meta && !key.ctrl;
    if (plainEnter) {
      // A trailing backslash continues the prompt on a new line.
      if (input.plainText.slice(0, cursorIndex()).endsWith("\\")) {
        key.preventDefault();
        input.deleteCharBackward();
        input.newLine();
        return;
      }
      if (matches.length) {
        key.preventDefault();
        return completeMention();
      }
    }

    if (matches.length && (key.name === "up" || key.name === "down")) {
      key.preventDefault();
      selected = (selected + (key.name === "up" ? -1 : 1) + matches.length) % matches.length;
      return drawCompletions();
    }

    if (key.name === "up" && !key.shift && !key.meta && !key.ctrl && atEdge("top")) {
      const entry = history.prev(inputMode === "bash" ? `!${input.plainText}` : inputMode === "memory" ? `#${input.plainText}` : input.plainText);
      if (entry !== null) {
        key.preventDefault();
        recall(entry);
      }
      return;
    }
    if (key.name === "down" && !key.shift && !key.meta && !key.ctrl && atEdge("bottom")) {
      const entry = history.next();
      if (entry !== null) {
        key.preventDefault();
        recall(entry);
      }
      return;
    }

    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      return scroll.scrollBy(key.name === "pageup" ? -0.5 : 0.5, "viewport");
    }
    if (key.name === "end" && key.ctrl) {
      key.preventDefault();
      return scroll.scrollTo(Infinity);
    }

    if (key.meta && !key.ctrl && key.name === "s") {
      key.preventDefault();
      return toggleStash();
    }

    const action = key.ctrl && !key.meta && !key.shift ? ctrlKeys[key.name] : undefined;
    if (action) {
      key.preventDefault();
      void action();
    }
  }

  renderer.keyInput.on("keypress", onKey);
  renderer.on("focus", () => (focused = true));
  renderer.on("blur", () => (focused = false));
  renderer.on("resize", layout);
  renderer.on("theme_mode", () => {
    if (settings.theme === "auto") setTheme();
  });
  renderer.on("selection", (selection: { getSelectedText(): string }) => {
    const picked = selection.getSelectedText();
    if (picked.trim()) void copy(picked).then((ok) => ok && flash("Copied selection", "success", 1200));
  });

  // ── start ───────────────────────────────────────────────────────────────
  applyChrome();
  resetTranscript();
  listFiles(cwd);

  try {
    agent = await startAgent(cwd, { onUpdate, onPermission });
  } catch (err: any) {
    renderer.destroy();
    console.error("Failed to start the agent:", err?.message ?? err);
    console.error(`Agent log: ${AGENT_LOG}`);
    process.exit(1);
  }

  agent.exited.then((code) => {
    disconnected = true;
    busy = false;
    turn = null;
    stopSpinner();
    menus.cancelAll();
    note(`The agent exited (code ${code}). Restart btr to continue; its log is ${AGENT_LOG}`, "error");
    drawStatus();
  });

  try {
    let loaded = false;
    if (typeof opts.resume === "string") {
      await loadSession(opts.resume);
      loaded = true;
    } else if (opts.continueLast) {
      const last = (await agent.listSessions().catch(() => []))[0];
      if (last) {
        await loadSession(last.sessionId, last.title ?? "");
        loaded = true;
      } else flash("No earlier session to continue: starting a new one");
    }
    if (!loaded && opts.resume === true) loaded = await pickSession();
    if (!loaded) await agent.newSession();
  } catch (err: any) {
    renderer.destroy();
    console.error("Failed to start a session:", err?.message ?? err);
    console.error(`Agent log: ${AGENT_LOG}`);
    agent.stop();
    process.exit(1);
  }

  if (opts.model && !(await setOptionByName("model", opts.model))) flash(`No model matches "${opts.model}"`, "warning");
  if (opts.mode && !(await setOptionByName("mode", opts.mode))) flash(`No mode matches "${opts.mode}"`, "warning");
  markReady();
  refreshSplash();
  layout();
  drawStatus();
  if (opts.prompt) {
    history.add(opts.prompt);
    void send(opts.prompt);
  }
}
