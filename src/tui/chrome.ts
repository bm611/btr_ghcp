import { type TextChunk, bold, fg } from "@opentui/core";
import { choices } from "../agent/config-options";
import { formatDuration, formatTokens, tildify, trunc, truncStart } from "../core/format";
import { blend, hatchedTitle, styled, todoLine, toneColor, toneGlyph, type Tone } from "../ui/text";
import { G } from "../ui/theme";
import type { App } from "./app";
import { HELP_FOOTER, HELP_KEYS } from "./keys";
import { MODES } from "./modes";
import { saveSettings } from "./settings";
import { SIDEBAR_WIDTH } from "./view";

/** Narrower windows hide the sidebar. */
const SIDEBAR_MIN_WINDOW = 110;

export type Chrome = ReturnType<typeof createChrome>;

/**
 * Everything drawn around the conversation: the status line under the prompt, the sidebar,
 * the shortcut panel, the pinned to-dos, the queue, the working line and the window title.
 * Each `draw` reads the state it shows from the other parts, so any of them can call it.
 */
export function createChrome(app: App) {
  const { renderer, settings, view } = app;
  let toast: { text: string; tone: Tone } | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let showHelp = false;
  let showTodos = false;
  /** Details: tool output and thinking in full. For this run only; nothing is saved. */
  let verbose = false;
  let focused = true;
  let spinTimer: ReturnType<typeof setInterval> | undefined;
  let spinTick = 0;

  const sidebarShown = () => settings.sidebar && renderer.width >= SIDEBAR_MIN_WINDOW;

  /** A message in the status line that clears itself. */
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

  /** Rings the bell when the terminal is in the background. */
  function notify() {
    if (settings.notifications && !focused) process.stdout.write("\x07");
  }

  function setTitle() {
    const { sessionTitle, busy } = app.conversation;
    const name = sessionTitle ? sessionTitle.split("\n")[0]!.slice(0, 60) : tildify(app.cwd);
    renderer.setTerminalTitle(`${busy ? G.diamond : G.model} ${name}`);
  }

  /** Applies the theme to everything outside the transcript. */
  function apply() {
    const th = app.look.th;
    const fill = settings.background ? th.bg : "transparent";
    renderer.setBackgroundColor(fill);
    view.root.backgroundColor = fill;
    view.sidebar.borderColor = th.separator;
    view.completions.backgroundColor = fill;
    const { input } = view;
    input.textColor = th.fg;
    input.focusedTextColor = th.fg;
    input.placeholderColor = th.fgFaint;
    input.cursorColor = th.mono ? th.fg : th.secondary;
    input.selectionBg = th.primary;
    input.selectionFg = th.onPrimary;
    view.queued.fg = th.fgMuted;
    layout();
  }

  /** Picks the theme again and redraws everything in it. */
  function applyTheme() {
    app.look.reload();
    apply();
    app.transcript.rebuild();
    app.menus.refresh();
    app.prompt.drawCompletions();
    drawSpinner();
  }

  function layout() {
    view.sidebar.visible = sidebarShown();
    drawSidebar();
    app.prompt.draw();
    drawTodos();
    drawHelp();
    drawStatus();
  }

  function modeColor(mode: string) {
    const th = app.look.th;
    const m = mode.toLowerCase();
    return m.includes("plan") ? th.plan : m.includes("auto") ? th.yolo : th.fg;
  }

  function drawSidebar() {
    if (!view.sidebar.visible) return;
    const th = app.look.th;
    const { conversation: conv, options } = app;
    const w = SIDEBAR_WIDTH - 3;
    const parts: (TextChunk | string)[] = [];
    const line = (...c: (TextChunk | string)[]) => parts.push(...c, "\n");
    const section = (name: string) => {
      parts.push("\n");
      line(bold(fg(th.fgSubtle)(name)), fg(th.separator)(" " + G.rule.repeat(Math.max(0, w - name.length - 1))));
    };

    line(...hatchedTitle(th, "btr", w));
    parts.push("\n");
    line(bold(fg(th.fg)(trunc((conv.sessionTitle || "New Session").split("\n")[0]!, w))));
    line(fg(th.fgMuted)(truncStart(tildify(app.cwd), w)));

    section("Model");
    line(fg(th.primary)(`${G.model} `), fg(th.fg)(trunc(options.modelLabel() || "unknown", w - 2)));
    const mode = options.modeName();
    if (mode) line(fg(th.fgMuted)("  mode "), fg(modeColor(mode))(mode));
    const pct = conv.contextPct();
    const usage = conv.usage;
    if (pct !== null && usage) {
      const barW = w - 2;
      const filled = Math.max(0, Math.min(barW, Math.round((pct / 100) * barW)));
      line("  ", fg(pct >= 80 ? th.warning : th.primary)("━".repeat(filled)), fg(th.separator)("━".repeat(barW - filled)));
      line(fg(th.fgMuted)(`  ${pct}% · ${formatTokens(usage.used)} / ${formatTokens(usage.size)} tokens`));
      if (usage.cost) line(fg(th.fgMuted)(`  ${usage.cost.amount.toFixed(4)} ${usage.cost.currency}`));
    }

    section("Modified Files");
    const files = new Map<string, { added: number; removed: number }>();
    for (const list of conv.changes.values())
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

    if (conv.plan.length) {
      section("To-Dos");
      for (const e of conv.plan.slice(0, 10)) line(...todoLine(th, { ...e, content: trunc(e.content, w - 2) }).chunks);
    }

    section("Permissions");
    line(options.yolo() ? bold(fg(th.yolo)("full access")) : fg(th.fgMuted)("ask before tools"), fg(th.fgFaint)("  ctrl+y"));
    view.sidebarText.content = styled(...parts);
  }

  /**
   * The line under the prompt, fx's statusline: permissions, model, mode and context,
   * joined by " · ". A flash takes its place for a moment.
   */
  function drawStatus() {
    const th = app.look.th;
    const { conversation: conv, options, prompt } = app;
    const { status } = view;
    status.visible = !showHelp;
    if (toast) {
      const color = toast.tone === "dim" || toast.tone === "info" ? th.fgSubtle : toneColor(th, toast.tone);
      status.content = styled(fg(color)(toneGlyph(toast.tone) + toast.text));
      return;
    }
    if (conv.disconnected) {
      status.content = styled(fg(th.error)(`${G.fail} agent disconnected · restart btr to continue`));
      return;
    }
    if (prompt.mode !== "prompt") {
      status.content = styled(fg(th.fgMuted)(MODES[prompt.mode].status));
      return;
    }
    const parts: TextChunk[][] = [];
    parts.push([options.yolo() ? fg(th.fg)("full access") : fg(th.fgMuted)("ask")]);
    if (!app.agent?.sessionId) parts.push([fg(th.fgMuted)(`connecting${G.ellipsis}`)]);
    if (options.modelName()) parts.push([fg(th.fgMuted)(options.modelLabel())]);
    const modeOption = options.option("mode");
    const mode = options.modeName();
    if (modeOption && mode && choices(modeOption)[0]?.name !== mode) parts.push([fg(th.fg)(mode.toLowerCase())]);
    const pct = conv.contextPct();
    const usage = conv.usage;
    if (usage?.size && pct !== null) parts.push([fg(pct >= 80 ? th.warning : th.fgMuted)(`${formatTokens(usage.used)}/${formatTokens(usage.size)} ${pct}%`)]);
    if (verbose) parts.push([fg(th.fgMuted)("details")]);
    if (prompt.stash !== null) parts.push([fg(th.fgMuted)("stashed")]);
    status.content = styled(...parts.flatMap((p, i) => (i ? [fg(th.fgFaint)(" · "), ...p] : p)));
  }

  /** The shortcut panel: three columns when they fit, else one. */
  function drawHelp() {
    view.helpPanel.visible = showHelp;
    if (!showHelp) return;
    const th = app.look.th;
    const perColumn = Math.ceil(HELP_KEYS.length / 3);
    const columns = [0, 1, 2].map((c) => HELP_KEYS.slice(c * perColumn, (c + 1) * perColumn));
    const colWidth = Math.floor((renderer.width - 4) / 3);
    const descWidth = colWidth - 12;
    const grid = descWidth >= 14 ? columns : [HELP_KEYS];
    const rows: (TextChunk | string)[] = [];
    for (let r = 0; r < grid[0]!.length; r++) {
      if (r) rows.push("\n");
      for (const col of grid) {
        const entry = col[r];
        if (!entry) continue;
        const [k, d] = entry;
        rows.push(bold(fg(th.fgSubtle)(k.padEnd(12))), fg(th.fgMuted)(grid.length > 1 ? trunc(d, descWidth - 1).padEnd(descWidth) : d));
      }
    }
    rows.push("\n\n", fg(th.fgFaint)(HELP_FOOTER));
    view.helpPanel.content = styled(...rows);
  }

  function drawTodos() {
    const { plan } = app.conversation;
    const visible = showTodos && plan.length > 0;
    view.todoPanel.visible = visible;
    if (!visible) return;
    const th = app.look.th;
    const done = plan.filter((e) => e.status === "completed").length;
    const parts: (TextChunk | string)[] = [bold(fg(th.fg)("To-Dos")), fg(th.fgMuted)(`  ${done}/${plan.length}`)];
    for (const e of plan) parts.push("\n ", ...todoLine(th, e).chunks);
    view.todoPanel.content = styled(...parts);
  }

  function drawQueue() {
    const th = app.look.th;
    const { queue } = app.conversation;
    view.queued.visible = queue.length > 0;
    view.queued.content = styled(
      ...queue.flatMap((q, i) => [i ? "\n" : "", fg(th.fgFaint)(`${G.thick} queued `), fg(th.fgMuted)(trunc(q.replace(/\n/g, " ⏎ "), 80))]),
    );
  }

  /** fx's working line: "• Generating (12s) (↓1.2k)", a light sweeping across the label. */
  function drawSpinner() {
    const { busy, turn, plan } = app.conversation;
    const visible = busy && !!turn && !app.menus.active;
    view.spinner.visible = visible;
    if (!visible || !turn) return;
    const th = app.look.th;
    const active = plan.find((e) => e.status === "in_progress")?.content;
    const chars = [...trunc(active ?? turn.label, 60)];
    // A band of light a few characters wide passes over the label, then rests.
    const period = chars.length + 16;
    const at = (spinTick % period) - 4;
    const shimmer = chars.map((ch, i) => fg(blend(th.fg, th.fgFaint, Math.min(1, Math.abs(i - at) / 4)))(ch));
    const info = [`(${formatDuration(Date.now() - turn.since)})`];
    const tokens = Math.round(turn.chars / 4);
    if (tokens > 0) info.push(`(↓${formatTokens(tokens)})`);
    const blink = Math.floor(spinTick / 8) % 2 === 0;
    view.spinner.content = styled(fg(blink ? th.fg : th.fgFaint)(`${G.pending} `), ...shimmer, fg(th.fgFaint)(` ${info.join(" ")}`));
  }

  function startSpinner() {
    spinTick = 0;
    clearInterval(spinTimer);
    spinTimer = setInterval(() => {
      spinTick++;
      drawSpinner();
      if (spinTick % 8 === 0) app.transcript.tick();
    }, 60);
    drawSpinner();
  }

  function stopSpinner() {
    clearInterval(spinTimer);
    spinTimer = undefined;
    drawSpinner();
  }

  return {
    flash,
    notify,
    setTitle,
    apply,
    applyTheme,
    layout,
    drawSidebar,
    drawStatus,
    drawTodos,
    drawQueue,
    drawSpinner,
    startSpinner,
    stopSpinner,
    get verbose() {
      return verbose;
    },
    get helpShown() {
      return showHelp;
    },
    set focused(value: boolean) {
      focused = value;
    },
    toggleVerbose() {
      verbose = !verbose;
      app.transcript.rebuild();
      drawStatus();
    },
    toggleHelp() {
      showHelp = !showHelp;
      drawHelp();
      drawStatus();
    },
    toggleTodos() {
      showTodos = !showTodos;
      drawTodos();
      if (showTodos && !app.conversation.plan.length) flash("No to-dos yet");
    },
    toggleSidebar() {
      settings.sidebar = !settings.sidebar;
      void saveSettings(settings);
      if (settings.sidebar && renderer.width < SIDEBAR_MIN_WINDOW) flash(`The sidebar needs a window at least ${SIDEBAR_MIN_WINDOW} columns wide`, "warning");
      layout();
    },
  };
}
