import type * as acp from "@agentclientprotocol/sdk";
import { TextRenderable, type TextChunk, bg, bold, fg } from "@opentui/core";
import { tildify, timeAgo, trunc, truncStart } from "../core/format";
import { blend, styled } from "../ui/text";
import { G } from "../ui/theme";
import { VERSION } from "../version";
import type { App } from "./app";

/** Recent sessions listed at most. */
const RECENT = 5;
/** The widest the dashboard's rows get. */
const MAX_WIDTH = 50;

/** The name in ANSI Shadow block letters, for windows with room for it. */
const LOGO = [
  "██████╗ ████████╗██████╗ ",
  "██╔══██╗╚══██╔══╝██╔══██╗",
  "██████╔╝   ██║   ██████╔╝",
  "██╔══██╗   ██║   ██╔══██╗",
  "██████╔╝   ██║   ██║  ██║",
  "╚═════╝    ╚═╝   ╚═╝  ╚═╝",
];
/** Two rows of half blocks, for short windows. */
const LOGO_SMALL = ["█▄▄ ▀█▀ █▀█", "█▄█  █  █▀▄"];
/** The box-drawing shadow behind the big letters. */
const OUTLINE = new Set([..."╔╗╚╝═║"]);

type Row = { icon: string; label: string; right: string; run: () => unknown };

export type Dashboard = ReturnType<typeof createDashboard>;

/**
 * The start page, after Neovim dashboards: the name, a column of actions with their keys,
 * the latest sessions here and where you are, centered above the prompt. It shows while the
 * session is empty and gives way to the conversation at its first entry; the sidebar hides
 * meanwhile. Every row is clickable, and its key works from the prompt as always.
 */
export function createDashboard(app: App) {
  const { renderer, view } = app;
  let shown = false;
  let sessions: acp.SessionInfo[] = [];
  let branch = "";

  /** Empty means nothing but the one-line welcome. */
  const empty = () => app.transcript.entries.every((e) => e.item.type === "splash");

  function actions(): Row[] {
    const { commands } = app;
    const cmd = (id: string, icon: string, label: string): Row | null => {
      const c = commands.list.find((x) => x.id === id);
      return c ? { icon, label, right: c.key ?? c.hint ?? "", run: () => commands.run(c) } : null;
    };
    const canResume = !!app.agent?.capabilities.loadSession;
    return [
      { icon: "≡", label: "Command palette", right: "ctrl+p", run: () => commands.openPalette() },
      canResume ? cmd("sessions", "↺", "Resume session") : null,
      cmd("model", G.model, "Switch model"),
      { icon: "⇄", label: "Cycle agent mode", right: "shift+tab", run: () => app.options.cycleMode() },
      cmd("history", G.search, "Search prompt history"),
      cmd("init", G.edit, "Initialize project"),
      cmd("help", "?", "Keybindings"),
      cmd("quit", G.fail, "Quit"),
    ].filter((r): r is Row => !!r);
  }

  /** The name in block letters, along the theme's gradient; the outline drawn faint behind it. */
  function logo(big: boolean) {
    const th = app.look.th;
    const art = big ? LOGO : LOGO_SMALL;
    const w = Math.max(...art.map((l) => [...l].length));
    const lines = art.map((l, r) => {
      const chars = [...l.padEnd(w)];
      return chars.map((ch, c) => {
        if (ch === " ") return ch;
        if (OUTLINE.has(ch)) return fg(th.fgGutter)(ch);
        // Monochrome themes fade top to bottom; the others run left to right, primary to secondary.
        const color = th.mono ? blend(th.fg, th.fgDim, r / Math.max(1, art.length - 1)) : blend(th.primary, th.secondary, c / Math.max(1, w - 1));
        return bold(fg(color)(ch));
      });
    });
    return styled(...lines.flatMap((l, i) => (i ? ["\n", ...l] : l)));
  }

  function line(content: ReturnType<typeof styled>, extra: Record<string, unknown> = {}) {
    const node = new TextRenderable(renderer, { content, flexShrink: 0, wrapMode: "none", truncate: true, ...extra });
    view.dashboard.add(node);
    return node;
  }

  /** A section's name and a rule out to the edge of the column. */
  function heading(width: number, name: string) {
    const th = app.look.th;
    // Indented one cell, under the rows' icons.
    line(styled(" ", bold(fg(th.fgDim)(name)), fg(th.separatorSubtle)(" " + G.rule.repeat(Math.max(0, width - name.length - 3)) + " ")), { marginTop: 1, width });
  }

  /** A clickable row: an icon, the label, dotted leaders, then its key or time. Hovering lifts it. */
  function row(width: number, r: Row, tone: { icon: string; label: string; right: string }) {
    const th = app.look.th;
    const room = width - r.right.length - 6;
    const text = trunc(r.label, room);
    const lead = Math.max(1, room - text.length);
    const draw = (hot: boolean) => {
      const lift = (c: TextChunk) => (hot ? bg(th.bgRaised)(c) : c);
      return styled(
        lift(fg(hot ? th.fg : tone.icon)(` ${r.icon} `)),
        lift((hot ? bold : (c: TextChunk) => c)(fg(hot ? th.fg : tone.label)(text))),
        lift(fg(hot ? th.fgGutter : th.separatorSubtle)(" " + "·".repeat(lead) + " ")),
        lift(fg(hot ? th.fgSubtle : tone.right)(r.right + " ")),
      );
    };
    const node = line(draw(false), { width });
    node.onMouseDown = () => void r.run();
    node.onMouseOver = () => (node.content = draw(true));
    node.onMouseOut = () => (node.content = draw(false));
  }

  function clearNodes() {
    for (const c of view.dashboard.getChildren()) {
      view.dashboard.remove(c);
      c.destroyRecursively();
    }
  }

  /**
   * Fills the dashboard in for the room the window has. What gives way first when it is
   * short: the big logo, then the recent sessions, then the actions.
   */
  function draw() {
    if (!shown) return;
    clearNodes();
    const th = app.look.th;
    const { options, agent } = app;
    const width = Math.min(MAX_WIDTH, renderer.width - 6);
    // What is left above the prompt and the status line.
    const room = renderer.height - 6;
    const rows = actions();
    const recent = sessions.filter((s) => s.sessionId !== agent?.sessionId).slice(0, RECENT);

    // Small logo (2), tagline (2), actions (1 + n), context (2).
    const base = LOGO_SMALL.length + 2 + 1 + rows.length + 2;
    const fitsActions = room >= base;
    const fitsRecent = recent.length > 0 && room >= base + 2 + recent.length;
    const used = fitsRecent ? base + 2 + recent.length : base;
    const big = renderer.width >= LOGO[0]!.length + 4 && room >= used + LOGO.length - LOGO_SMALL.length;

    line(logo(big), { truncate: false });
    const tagline: TextChunk[] = [fg(th.fgDim)(`v${VERSION}`)];
    const name = agent?.info?.title ?? agent?.info?.name;
    if (name) tagline.push(fg(th.fgGutter)(`  ${G.middot}  `), fg(th.fgMuted)(name));
    line(styled(...tagline), { marginTop: 1 });

    const accent = th.mono ? th.fgMuted : th.primary;
    if (fitsActions) {
      const first = view.dashboard.getChildren().length;
      for (const r of rows) row(width, r, { icon: accent, label: th.fgSubtle, right: th.fgDim });
      const top = view.dashboard.getChildren()[first];
      if (top) top.marginTop = 1;
    } else line(styled(fg(th.fgDim)("ctrl+p"), fg(th.fgGutter)(" commands  ·  "), fg(th.fgDim)("ctrl+g"), fg(th.fgGutter)(" keys")), { marginTop: 1 });

    if (fitsRecent) {
      heading(width, "Recent");
      for (const s of recent) {
        const r: Row = {
          icon: G.bullet,
          label: (s.title ?? s.sessionId).split("\n")[0]!,
          right: timeAgo(s.updatedAt),
          run: () => app.conversation.loadSession(s.sessionId, s.title ?? ""),
        };
        row(width, r, { icon: th.fgGutter, label: th.fgMuted, right: th.fgGutter });
      }
    }

    const sep = fg(th.fgGutter)(`  ${G.middot}  `);
    const ctx: TextChunk[] = [fg(th.fgMuted)(truncStart(tildify(app.cwd), Math.max(12, Math.floor(width / 2))))];
    if (branch) ctx.push(sep, fg(th.fgGutter)("on "), fg(th.fgMuted)(branch));
    const model = options.modelLabel();
    if (model) ctx.push(sep, fg(accent)(`${G.model} `), fg(th.fgDim)(model));
    const mode = options.modeName();
    if (mode) ctx.push(sep, fg(th.fgDim)(mode.toLowerCase()));
    line(styled(...ctx), { marginTop: 1, maxWidth: renderer.width - 4 });
  }

  /**
   * Shows the dashboard when the transcript is empty and hides it at its first entry.
   * Cheap when nothing changed: the transcript calls it on every entry it adds.
   */
  function sync() {
    const want = empty();
    if (want === shown) return;
    shown = want;
    view.dashboard.visible = shown;
    view.scroll.visible = !shown;
    view.filler.visible = !shown;
    if (!shown) clearNodes();
    app.chrome.layout();
  }

  /** Looks up the recent sessions and the git branch again, then redraws. */
  async function refresh() {
    const agent = app.agent;
    const [list, head] = await Promise.all([
      agent?.capabilities.loadSession ? agent.listSessions().catch(() => []) : Promise.resolve([]),
      Bun.$`git -C ${app.cwd} branch --show-current`
        .quiet()
        .nothrow()
        .text()
        .catch(() => ""),
    ]);
    sessions = list;
    branch = head.trim();
    draw();
  }

  return {
    sync,
    draw,
    refresh,
    get shown() {
      return shown;
    },
  };
}
