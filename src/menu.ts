import { BoxRenderable, type CliRenderer, type KeyEvent, type Renderable, StyledText, type TextChunk, TextRenderable, bg, bold, fg } from "@opentui/core";
import { fuzzyFilter } from "./files";
import { G, hatchedTitle, type Theme } from "./theme";

export type MenuOption = {
  label: string;
  value: string;
  /** Right-aligned: a shortcut, a time, a short note. */
  hint?: string;
  /** A letter that picks this option directly (buttons). */
  key?: string;
  /** A short name for the help line, when the label is long. */
  short?: string;
  /** The tab the option belongs to, when the dialog has tabs. */
  tab?: string;
};

export type MenuRequest = {
  title: string;
  /** Extra content between the title and the options, built when the dialog shows. */
  body?: () => Renderable[];
  question?: string;
  options: MenuOption[];
  /** Typing narrows the options. Without it, digits pick an option. */
  filterable?: boolean;
  placeholder?: string;
  /** Tabs above the list, switched with tab; options name theirs. */
  tabs?: string[];
  /** Show the options as a row of buttons, as a permission request does. */
  buttons?: boolean;
  /** The option highlighted first. */
  initial?: number;
  /** Widest the dialog may be. */
  width?: number;
  /**
   * The filter doubles as typed text, for `/cmd args` in the palette. A space answers
   * `space:<highlighted value>` to complete that option; with nothing matching, a space or
   * Enter answers `text:<filter>` so the caller can put it back in the prompt.
   */
  passthrough?: boolean;
};

type Pending = MenuRequest & { resolve: (value: string | null) => void };

const VISIBLE = 12;
const chunk = (text: string): TextChunk => ({ __isChunk: true, text });
const styled = (...parts: (TextChunk | string)[]) => new StyledText(parts.map((p) => (typeof p === "string" ? chunk(p) : p)));

/**
 * Pickers (the command palette, models, sessions) open in a box in the middle of the
 * screen. Permission requests rise from the bottom as a panel under a divider instead,
 * next to the tool call they ask about. Either way: a title, the options, a dim line of keys.
 * Dialogs over the interface: the command palette, pickers, permission requests.
 * Requests can overlap (parallel tool calls), so they queue and the oldest shows.
 * Replacing an open request would answer it as cancelled, which denies that tool call.
 */
export class Menus {
  private queue: Pending[] = [];
  private overlay: BoxRenderable;
  private box: BoxRenderable;
  private title: TextRenderable;
  private body: BoxRenderable;
  private question: TextRenderable;
  private filterRow: TextRenderable;
  private list: BoxRenderable;
  private rows: { box: BoxRenderable; label: TextRenderable; hint: TextRenderable }[];
  private buttonRow: TextRenderable;
  private help: TextRenderable;
  private selected = 0;
  private filter = "";
  private tab = 0;
  private shown: MenuOption[] = [];

  constructor(
    private renderer: CliRenderer,
    private theme: () => Theme,
    private onChange: (open: boolean) => void,
  ) {
    const text = (extra: Record<string, unknown> = {}) =>
      new TextRenderable(renderer, { content: "", flexShrink: 0, wrapMode: "none", truncate: true, ...extra });
    this.overlay = new BoxRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 100,
      justifyContent: "flex-end",
      alignItems: "stretch",
      visible: false,
    });
    this.box = new BoxRenderable(renderer, {
      flexDirection: "column",
      flexShrink: 0,
      border: ["top"],
      borderStyle: "single",
      paddingX: 2,
      paddingTop: 1,
      paddingBottom: 1,
    });
    this.title = text({ marginBottom: 1 });
    this.body = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0, marginBottom: 1, maxHeight: 22, overflow: "hidden" });
    this.question = text({ marginBottom: 1, wrapMode: "word", truncate: false });
    this.filterRow = text({ marginBottom: 1 });
    this.list = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0 });
    this.rows = Array.from({ length: VISIBLE }, () => {
      const box = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0 });
      const label = text({ flexGrow: 1, flexShrink: 1 });
      const hint = text({ marginLeft: 2 });
      box.add(label);
      box.add(hint);
      this.list.add(box);
      return { box, label, hint };
    });
    this.buttonRow = text();
    this.help = text({ marginTop: 1 });
    for (const node of [this.title, this.body, this.question, this.filterRow, this.list, this.buttonRow, this.help]) this.box.add(node);
    this.overlay.add(this.box);
    renderer.root.add(this.overlay);
    renderer.on("resize", () => this.refresh());
  }

  get active() {
    return this.queue.length > 0;
  }

  /** The title of the open dialog, if any. */
  get current() {
    return this.queue[0]?.title;
  }

  open(req: MenuRequest) {
    return new Promise<string | null>((resolve) => {
      this.queue.push({ ...req, resolve });
      if (this.queue.length === 1) this.show();
    });
  }

  /** Answers the open request and shows the next. */
  settle(value: string | null) {
    this.queue.shift()?.resolve(value);
    this.show();
  }

  /** Answers every request as cancelled. */
  cancelAll() {
    for (const p of this.queue.splice(0)) p.resolve(null);
    this.show();
  }

  /** Redraws the open request, after a theme change or a resize. */
  refresh() {
    if (this.active) this.show(false);
  }

  /** Pickers float in the middle; approvals (buttons) dock to the bottom. */
  private centered(p: Pending) {
    return !p.buttons;
  }

  /** The box's outer width: the request's own, within the window; a docked panel spans it. */
  private width(p: Pending) {
    if (!this.centered(p)) return Math.max(30, this.renderer.width);
    return Math.max(30, Math.min(p.width ?? 64, this.renderer.width - 4));
  }

  private show(reset = true) {
    const p = this.queue[0];
    for (const child of this.body.getChildren()) {
      this.body.remove(child);
      child.destroyRecursively();
    }
    if (!p) {
      this.overlay.visible = false;
      this.onChange(false);
      return;
    }
    const th = this.theme();
    if (reset) {
      this.filter = "";
      this.tab = 0;
      this.selected = Math.max(0, Math.min(p.initial ?? 0, p.options.length - 1));
    }
    const centered = this.centered(p);
    this.overlay.justifyContent = centered ? "center" : "flex-end";
    this.overlay.alignItems = centered ? "center" : "stretch";
    this.box.border = centered ? true : ["top"];
    this.box.borderStyle = centered ? "rounded" : "single";
    this.box.width = centered ? this.width(p) : "auto";
    this.box.backgroundColor = th.bg;
    this.box.borderColor = centered ? th.fgFaint : th.separator;
    const body = p.body?.() ?? [];
    for (const node of body) this.body.add(node);
    this.body.visible = body.length > 0;
    this.question.content = p.question ?? "";
    this.question.fg = th.fg;
    this.question.visible = !!p.question;
    this.filterRow.visible = !!p.filterable;
    this.list.visible = !p.buttons;
    this.buttonRow.visible = !!p.buttons;
    this.overlay.visible = true;
    this.draw();
    this.onChange(true);
  }

  private draw() {
    const p = this.queue[0];
    if (!p) return;
    const th = this.theme();
    // Padding, and the side borders of a centered box.
    const inner = this.width(p) - (this.centered(p) ? 6 : 4);

    // Title, then the tabs as "System · Agent" with the open one bright.
    const tabs: TextChunk[] = [];
    if (p.tabs?.length) {
      tabs.push(fg(th.fgFaint)("  "));
      p.tabs.forEach((name, i) => {
        if (i) tabs.push(fg(th.fgFaint)(" · "));
        tabs.push(i === this.tab && !this.filter ? bold(fg(th.fg)(name)) : fg(th.fgMuted)(name));
      });
    }
    const tabsWidth = tabs.reduce((n, c) => n + c.text.length, 0);
    this.title.content = th.mono ? styled(bold(fg(th.fg)(p.title)), ...tabs) : styled(...hatchedTitle(th, p.title, inner, tabsWidth), ...tabs);

    // A search looks through every tab; the tabs only split the list while browsing.
    const searching = !!(p.filterable && this.filter);
    const pool = p.tabs?.length && !searching ? p.options.filter((o) => (o.tab ?? p.tabs![0]) === p.tabs![this.tab]) : p.options;
    this.shown = p.filterable && this.filter ? fuzzyFilter(this.filter, pool, (o) => `${o.label} ${o.hint ?? ""}`, 300) : pool;
    this.selected = Math.max(0, Math.min(this.selected, this.shown.length - 1));

    this.filterRow.content = this.filter
      ? styled(fg(th.fgMuted)(`${G.prompt} `), fg(th.fg)(this.filter), bg(th.fg)(" "))
      : styled(fg(th.fgMuted)(`${G.prompt} `), ...placeholderWithCursor(th, p.placeholder ?? "Type to filter"));

    if (p.buttons) {
      // One numbered button per row, the chosen one filled bright: fx's approval choices.
      const parts: TextChunk[] = [];
      this.shown.forEach((o, i) => {
        const on = i === this.selected;
        if (i) parts.push(chunk("\n"));
        const label = ` ${i + 1}  ${o.label} `.slice(0, inner);
        parts.push(on ? bold(bg(th.primary)(fg(th.onPrimary)(label))) : bg(th.bgRaised)(fg(th.fg)(label)));
      });
      this.buttonRow.content = styled(...parts);
    }

    // The list keeps the selection inside a window of VISIBLE rows.
    const start = Math.max(0, Math.min(this.selected - Math.floor(VISIBLE / 2), this.shown.length - VISIBLE));
    this.rows.forEach((row, i) => {
      const o = this.shown[start + i];
      row.box.visible = !!o && !p.buttons;
      if (!o) return;
      const on = start + i === this.selected;
      const number = p.filterable || p.tabs ? "" : `${start + i + 1}. `;
      row.box.backgroundColor = "transparent";
      row.label.content = styled(fg(on ? th.fg : th.fgFaint)(on ? `${G.select} ` : "  "), on ? bold(fg(th.fg)(number + o.label)) : fg(th.fgMuted)(number + o.label));
      row.hint.content = o.hint ?? "";
      row.hint.fg = on ? th.fgSubtle : th.fgFaint;
    });
    if (!this.shown.length && !p.buttons) {
      const row = this.rows[0]!;
      row.box.visible = true;
      row.box.backgroundColor = "transparent";
      row.label.content = styled(fg(th.fgMuted)("  No matches"));
      row.hint.content = "";
    }

    const keys: [string, string][] = [];
    if (p.tabs && p.tabs.length > 1 && !this.filter) keys.push(["tab", "switch list"]);
    if (p.passthrough && this.filter) keys.push(["space", "add arguments"]);
    if (p.buttons) {
      keys.push([`1–${this.shown.length}`, "choose"], ["↑↓", "options"]);
      for (const o of this.shown) if (o.key) keys.push([o.key, (o.short ?? o.label).toLowerCase()]);
    } else keys.push(["↑↓", "choose"]);
    keys.push(["enter", "confirm"], ["esc", "cancel"]);
    if (this.shown.length > VISIBLE) keys.push([`${this.selected + 1}/${this.shown.length}`, ""]);
    this.help.content = helpLine(th, keys, inner);
  }

  /** Handles a key while a request is open. Returns "cancel" when the user dismissed it with Esc or Ctrl+C. */
  handleKey(key: KeyEvent): "cancel" | void {
    const p = this.queue[0];
    if (!p) return;
    const move = (delta: number) => {
      if (!this.shown.length) return;
      this.selected = (this.selected + delta + this.shown.length) % this.shown.length;
      this.draw();
    };
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      this.settle(null);
      return "cancel";
    }
    if (key.name === "tab" && p.tabs && p.tabs.length > 1 && !this.filter) {
      this.tab = (this.tab + (key.shift ? -1 : 1) + p.tabs.length) % p.tabs.length;
      this.selected = 0;
      return this.draw();
    }
    const back = key.name === "up" || (key.ctrl && key.name === "p") || (!!p.buttons && (key.name === "left" || (key.name === "tab" && key.shift)));
    const forward = key.name === "down" || (key.ctrl && key.name === "n") || key.name === "tab" || (!!p.buttons && key.name === "right");
    if (back) return move(-1);
    if (forward) return move(1);
    if (key.name === "pageup") return move(-Math.min(VISIBLE, this.selected));
    if (key.name === "pagedown") return move(Math.min(VISIBLE, this.shown.length - 1 - this.selected));
    if (key.name === "return" || key.name === "kpenter") {
      const o = this.shown[this.selected];
      if (o) this.settle(o.value);
      else if (p.passthrough && this.filter) this.settle(`text:${this.filter}`);
      return;
    }
    if (p.passthrough && this.filter && key.sequence === " ") {
      const o = this.shown[this.selected];
      return this.settle(o ? `space:${o.value}` : `text:${this.filter} `);
    }
    if (p.filterable) {
      if (key.name === "backspace") {
        this.filter = this.filter.slice(0, -1);
        this.selected = 0;
        return this.draw();
      }
      if (key.ctrl && key.name === "u") {
        this.filter = "";
        return this.draw();
      }
      if (!key.ctrl && !key.meta && key.sequence && key.sequence.length === 1 && key.sequence >= " ") {
        this.filter += key.sequence;
        this.selected = 0;
        return this.draw();
      }
      return;
    }
    const byKey = this.shown.find((o) => o.key && o.key === key.name);
    if (byKey) return this.settle(byKey.value);
    const n = Number(key.name);
    if (Number.isInteger(n) && n >= 1 && n <= this.shown.length) this.settle(this.shown[n - 1]!.value);
  }
}

/** A placeholder whose first character carries the cursor. */
function placeholderWithCursor(th: Theme, text: string): TextChunk[] {
  return [bg(th.fgSubtle)(fg(th.bg)(text[0] ?? " ")), fg(th.fgFaint)(text.slice(1))];
}

/** "key desc • key desc", cut to `width` cells. */
export function helpLine(th: Theme, keys: [string, string][], width: number): StyledText {
  const parts: TextChunk[] = [];
  let used = 0;
  for (const [k, d] of keys) {
    const sep = parts.length ? (th.mono ? "  " : " • ") : "";
    const len = sep.length + k.length + (d ? d.length + 1 : 0);
    if (used + len > width) {
      parts.push(fg(th.fgFaint)(" …"));
      break;
    }
    if (sep) parts.push(fg(th.fgFaint)(sep));
    parts.push(th.mono ? fg(th.fgSubtle)(k) : bold(fg(th.fgSubtle)(k)));
    if (d) parts.push(fg(th.fgMuted)(" " + d));
    used += len;
  }
  return styled(...parts);
}
