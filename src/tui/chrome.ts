import { TextRenderable, type TextChunk, bold, fg } from "@opentui/core";
import { choices } from "../agent/config-options";
import { formatDuration, formatTokens, tildify, trunc, truncStart } from "../core/format";
import { hatchedTitle, styled, todoLine, toneColor, toneGlyph, type Tone } from "../ui/text";
import { G } from "../ui/theme";
import type { App } from "./app";
import { HELP_FOOTER, HELP_KEYS } from "./keys";
import { MODES } from "./modes";
import { saveSettings } from "./settings";

/** Narrower windows hide the sidebar. */
const SIDEBAR_MIN_WINDOW = 100;

export type Chrome = ReturnType<typeof createChrome>;

/**
 * Everything drawn around the conversation: the status line under the prompt, the sidebar,
 * the shortcut panel, the pinned to-dos, the queue, the working line, the scroll indicator
 * and the window title. Each `draw` reads the state it shows from the other parts.
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
  let hasUnread = false;

  const sidebarShown = () => settings.sidebar && renderer.width >= SIDEBAR_MIN_WINDOW;
  const sidebarWidth = () => Math.min(38, Math.max(28, Math.floor(renderer.width * 0.28)));

  const isScrolledUp = () => {
    const s = view.scroll;
    const vp = s.viewport.height || s.height;
    return s.scrollHeight > vp + 1 && s.scrollTop < s.scrollHeight - vp - 1;
  };

  function drawScrollJump() {
    const up = isScrolledUp();
    if (!up) hasUnread = false;
    view.scrollJump.visible = up;
    if (!up) return;
    const th = app.look.th;
    const label = hasUnread
      ? `${G.down} New output below · ctrl+end or click to jump`
      : `${G.down} Scrolled up · ctrl+end or click to jump to bottom`;
    view.scrollJump.content = styled(fg(hasUnread ? th.info : th.fgMuted)(label));
  }

  view.scroll.verticalScrollBar.onChange = () => drawScrollJump();

  function markUnread() {
    if (!isScrolledUp()) return;
    hasUnread = true;
    drawScrollJump();
  }

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
    view.sidebar.borderColor = th.separatorSubtle;
    view.completions.backgroundColor = fill;
    const { input } = view;
    input.textColor = th.info;
    input.focusedTextColor = th.info;
    input.placeholderColor = th.fgFaint;
    input.cursorColor = th.mono ? th.fg : th.secondary;
    input.selectionBg = th.primary;
    input.selectionFg = th.onPrimary;
    layout();
  }

  /** Picks the theme again and redraws everything in it. */
  function applyTheme() {
    app.look.reload();
    apply();
    app.transcript.rebuild();
    app.menus.refresh();
    app.prompt.drawCompletions();
    app.prompt.drawAttachments();
    drawSpinner();
  }

  function layout() {
    view.sidebar.visible = sidebarShown();
    if (view.sidebar.visible) view.sidebar.width = sidebarWidth();
    drawSidebar();
    app.prompt.draw();
    app.prompt.drawAttachments();
    drawScrollJump();
    drawTodos();
    drawQueue();
    drawHelp();
    drawStatus();
  }

  function modeColor(mode: string) {
    const th = app.look.th;
    const m = mode.toLowerCase();
    return m.includes("plan") ? th.plan : m.includes("auto") ? (th.mono ? th.fg : th.secondary) : th.fg;
  }

  function drawSidebar() {
    if (!view.sidebar.visible) return;
    const th = app.look.th;
    const { conversation: conv, options } = app;
    const w = sidebarWidth() - 3;
    const section = (parts: (TextChunk | string)[], name: string) => {
      parts.push("\n");
      parts.push(bold(fg(th.fgDim)(name)), fg(th.separatorSubtle)(" " + G.rule.repeat(Math.max(0, w - name.length - 1))), "\n");
    };

    const head: (TextChunk | string)[] = [];
    const line = (parts: (TextChunk | string)[], ...c: (TextChunk | string)[]) => parts.push(...c, "\n");
    line(head, ...hatchedTitle(th, "btr", w));
    head.push("\n");
    line(head, bold(fg(th.fg)(trunc((conv.sessionTitle || "New Session").split("\n")[0]!, w))));
    line(head, fg(th.fgMuted)(truncStart(tildify(app.cwd), w)));

    section(head, "Agent");
    line(head, fg(th.primary)(`${G.model} `), fg(th.fg)(trunc(options.modelLabel() || "unknown", w - 2)));
    const mode = options.modeName();
    if (mode) line(head, fg(th.fgMuted)("  mode "), fg(modeColor(mode))(mode));
    const pct = conv.contextPct();
    const usage = conv.usage;
    if (pct !== null && usage) {
      const barW = w - 2;
      const filled = Math.max(0, Math.min(barW, Math.round((pct / 100) * barW)));
      line(head, "  ", fg(pct >= 80 ? th.warning : th.primary)("━".repeat(filled)), fg(th.separatorSubtle)("━".repeat(barW - filled)));
      line(head, fg(th.fgDim)(`  ${pct}% · ${formatTokens(usage.used)} / ${formatTokens(usage.size)} tokens`));
      if (usage.cost) line(head, fg(th.fgDim)(`  ${usage.cost.amount.toFixed(4)} ${usage.cost.currency}`));
    }
    section(head, "Modified Files");
    view.sidebarHead.content = styled(...head.slice(0, -1));

    for (const c of view.sidebarFiles.getChildren()) {
      view.sidebarFiles.remove(c);
      c.destroyRecursively();
    }
    const files = new Map<string, { added: number; removed: number }>();
    for (const list of conv.changes.values())
      for (const c of list) {
        const f = files.get(c.path) ?? { added: 0, removed: 0 };
        f.added += c.added;
        f.removed += c.removed;
        files.set(c.path, f);
      }
    if (!files.size) {
      view.sidebarFiles.add(new TextRenderable(renderer, { content: "None", fg: th.fgGutter, flexShrink: 0 }));
    } else {
      for (const [path, f] of files) {
        const stats = ` +${f.added} -${f.removed}`;
        const row = new TextRenderable(renderer, {
          content: styled(fg(th.fgSubtle)(truncStart(path, w - stats.length)), fg(th.diffAddedFg)(` +${f.added}`), fg(th.diffRemovedFg)(` -${f.removed}`)),
          flexShrink: 0,
          wrapMode: "none",
          truncate: true,
        });
        row.onMouseDown = () => {
          const entry = app.transcript.findFileEntry(path);
          if (entry) app.transcript.scrollToEntry(entry);
          else flash(`No diff found for ${truncStart(path, 30)}`);
        };
        view.sidebarFiles.add(row);
      }
    }

    const foot: (TextChunk | string)[] = [];
    if (conv.plan.length) {
      section(foot, "To-Dos");
      for (const e of conv.plan) line(foot, ...todoLine(th, { ...e, content: trunc(e.content, w - 2) }).chunks);
    }
    section(foot, "Tool Permissions");
    foot.push(options.yolo() ? bold(fg(th.yolo)("full access")) : fg(th.fgMuted)("ask"), fg(th.fgGutter)("  ctrl+y"));
    view.sidebarFoot.content = styled(...foot);
  }

  /**
   * The line under the prompt, fx's statusline: permissions, model and mode on the left,
   * with context usage pushed to the far right. A flash takes its place for a moment.
   */
  function drawStatus() {
    const th = app.look.th;
    const { conversation: conv, options, prompt } = app;
    const { status, statusText, statusContext } = view;
    status.visible = !showHelp;
    statusContext.content = "";
    if (toast) {
      const color = toast.tone === "dim" || toast.tone === "info" ? th.fgSubtle : toneColor(th, toast.tone);
      statusText.content = styled(fg(color)(toneGlyph(toast.tone) + toast.text));
      return;
    }
    if (conv.disconnected) {
      statusText.content = styled(fg(th.error)(`${G.fail} agent disconnected · restart btr to continue`));
      return;
    }
    if (prompt.mode !== "prompt") {
      statusText.content = styled(fg(th.fgMuted)(MODES[prompt.mode].status));
      return;
    }
    const narrow = renderer.width < 92;
    const parts: TextChunk[][] = [];
    if (app.menus.active && conv.busy && conv.turn) {
      const blink = Math.floor(spinTick / 8) % 2 === 0;
      parts.push([fg(blink ? th.info : th.fgDim)(`${G.pending} ${conv.turn.label.toLowerCase()}`)]);
    }
    const permLabel = narrow ? "perm: " : "permissions: ";
    parts.push([fg(th.fgMuted)(permLabel), options.yolo() ? fg(th.yolo)("full access") : fg(th.fgDim)("ask")]);
    if (!app.agent?.sessionId) parts.push([fg(th.fgMuted)(`connecting${G.ellipsis}`)]);
    if (options.modelName()) parts.push([fg(th.fgDim)(options.modelLabel())]);
    const modeOption = options.option("mode");
    const mode = options.modeName();
    if (modeOption && mode && choices(modeOption)[0]?.name !== mode) {
      parts.push([fg(th.fgMuted)(narrow ? "" : "agent: "), fg(modeColor(mode))(mode.toLowerCase())]);
    }
    if (!narrow) {
      if (verbose) parts.push([fg(th.fgMuted)("details")]);
      if (prompt.stash !== null) parts.push([fg(th.fgMuted)("stashed")]);
    }
    statusText.content = styled(...parts.flatMap((p, i) => (i ? [fg(th.fgGutter)(" · "), ...p] : p)));
    const pct = conv.contextPct();
    const usage = conv.usage;
    if (usage?.size && pct !== null) {
      const barW = narrow ? 8 : 14;
      const label = `${pct}%`;
      const trackW = barW - label.length - 1;
      const filled = Math.max(0, Math.min(trackW, Math.round((pct / 100) * trackW)));
      statusContext.content = styled(
        fg(th.fgGutter)("ctx ["),
        fg(pct >= 80 ? th.warning : th.primary)("█".repeat(filled)),
        fg(th.fgDim)(` ${label}`),
        fg(th.separatorSubtle)("░".repeat(trackW - filled)),
        fg(th.fgGutter)("]"),
      );
    }
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
    rows.push("\n\n", fg(th.fgGutter)(HELP_FOOTER));
    view.helpPanel.content = styled(...rows);
  }

  function drawTodos() {
    const { plan } = app.conversation;
    const visible = showTodos && plan.length > 0;
    view.todoPanel.visible = visible;
    if (!visible) return;
    const th = app.look.th;
    const done = plan.filter((e) => e.status === "completed").length;
    const parts: (TextChunk | string)[] = [bold(fg(th.fg)("To-Dos")), fg(th.fgDim)(`  ${done}/${plan.length}`)];
    for (const e of plan) parts.push("\n ", ...todoLine(th, e).chunks);
    view.todoPanel.content = styled(...parts);
  }

  function drawQueue() {
    const th = app.look.th;
    const { queue } = app.conversation;
    for (const c of view.queued.getChildren()) {
      view.queued.remove(c);
      c.destroyRecursively();
    }
    view.queued.visible = queue.length > 0;
    if (!queue.length) return;
    queue.forEach((q, i) => {
      const last = i === queue.length - 1;
      const row = new TextRenderable(renderer, {
        content: styled(
          fg(th.fgGutter)(`${G.thick} queued `),
          fg(th.fgMuted)(trunc(q.replace(/\n/g, " ⏎ "), 70)),
          last ? fg(th.fgGutter)("  alt+↑ edit · alt+⌫ drop") : "",
        ),
        flexShrink: 0,
        wrapMode: "none",
        truncate: true,
      });
      row.onMouseDown = () => app.prompt.editQueued(i);
      view.queued.add(row);
    });
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
    // A band of light passes over the label with a smooth ease, then rests.
    // The band width and falloff are tuned so the sweep reads as continuous motion.
    const period = chars.length + 20;
    const at = (spinTick % period) - 6;
    const bandWidth = 5;
    const shimmer = chars.map((ch, i) => {
      const dist = Math.abs(i - at);
      const t = Math.min(1, dist / bandWidth);
      // Smooth falloff: the center is brightest, edges fade to faint.
      return fg(blendColor(th.fg, th.fgFaint, t * t))(ch);
    });
    const info = [`(${formatDuration(Date.now() - turn.since)})`];
    const tokens = Math.round(turn.chars / 4);
    if (tokens > 0) info.push(`(↓${formatTokens(tokens)})`);
    const blink = Math.floor(spinTick / 8) % 2 === 0;
    view.spinner.content = styled(fg(blink ? th.fg : th.fgDim)(`${G.pending} `), ...shimmer, fg(th.fgGutter)(` ${info.join(" ")}`));
  }

  function startSpinner() {
    spinTick = 0;
    clearInterval(spinTimer);
    spinTimer = setInterval(() => {
      spinTick++;
      drawSpinner();
      if (spinTick % 8 === 0) {
        app.transcript.tick();
        if (app.menus.active) drawStatus();
      }
    }, 50);
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
    drawScrollJump,
    markUnread,
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

import { blend as blendColor } from "../ui/text";
