import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
  ScrollBoxRenderable,
  type StyledText,
  type TextChunk,
  TextRenderable,
  bg,
  bold,
  fg,
} from "@opentui/core";
import { fuzzyFilter, fuzzyMatch } from "../core/fuzzy";
import { clearChildren, hatchedTitle, highlightMatches, styled } from "./text";
import { G, type Theme } from "./theme";

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
  /** Called as selection moves (and with null if cancelled) for live previews like themes. */
  onPreview?: (value: string | null) => void;
};

type Pending = MenuRequest & { resolve: (value: string | null) => void };

/** Rows of options shown at once; the list scrolls past that. */
const VISIBLE = 12;
const MAX_BUTTONS = 8;
const DIM_BACKGROUND = "#0000008c";

/**
 * Dialogs over the interface. Pickers (the command palette, models, sessions) open in a
 * box in the middle of the screen; permission requests (`buttons`) rise from the bottom as
 * a panel under a divider instead, next to the tool call they ask about. Either way: a
 * title, the options, a dim line of keys.
 *
 * Requests can overlap (parallel tool calls), so they queue and the oldest shows.
 * Replacing an open request would answer it as cancelled, which denies that tool call.
 */
export class Menus {
  private queue: Pending[] = [];
  private overlay: BoxRenderable;
  private box: BoxRenderable;
  private header: BoxRenderable;
  private title: TextRenderable;
  private tabRow: BoxRenderable;
  private body: ScrollBoxRenderable;
  private bodyContent: BoxRenderable;
  private question: TextRenderable;
  private filterRow: TextRenderable;
  private list: BoxRenderable;
  private rows: { box: BoxRenderable; label: TextRenderable; hint: TextRenderable }[];
  private buttonList: BoxRenderable;
  private buttons: TextRenderable[];
  private help: TextRenderable;
  private selected = 0;
  private filter = "";
  private filterCursor = 0;
  private tab = 0;
  private shown: MenuOption[] = [];
  private bodyScrollable = false;

  constructor(
    private renderer: CliRenderer,
    private theme: () => Theme,
    private onChange: (open: boolean) => void,
    /** Dim what is behind a dialog. Off when the terminal's own background shows through. */
    private dim: () => boolean = () => true,
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
      backgroundColor: "transparent",
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
    this.header = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0, marginBottom: 1 });
    this.title = text({ flexGrow: 1, flexShrink: 1 });
    this.tabRow = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0 });
    this.header.add(this.title);
    this.header.add(this.tabRow);

    this.body = new ScrollBoxRenderable(renderer, {
      flexDirection: "column",
      flexShrink: 0,
      height: 1,
      marginBottom: 1,
      verticalScrollbarOptions: { visible: true },
      contentOptions: { flexDirection: "column" },
    });
    this.bodyContent = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0 });
    this.body.add(this.bodyContent);
    this.bodyContent.onSizeChange = () => this.fitBody();

    this.question = text({ marginBottom: 1, wrapMode: "word", truncate: false });
    this.filterRow = text({ marginBottom: 1 });
    this.list = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0 });
    this.list.onMouseScroll = (event) => {
      const dir = event.scroll?.direction;
      if (dir === "up" || dir === "down") {
        event.stopPropagation();
        this.move(dir === "up" ? -1 : 1);
      }
    };
    this.rows = Array.from({ length: VISIBLE }, (_, i) => {
      const box = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0, paddingX: 1 });
      const label = text({ flexGrow: 1, flexShrink: 1 });
      const hint = text({ marginLeft: 2 });
      box.add(label);
      box.add(hint);
      box.onMouseDown = () => this.pickRow(i);
      this.list.add(box);
      return { box, label, hint };
    });

    this.buttonList = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0 });
    this.buttons = Array.from({ length: MAX_BUTTONS }, (_, i) => {
      const btn = text({ flexShrink: 0 });
      btn.onMouseDown = () => {
        const o = this.shown[i];
        if (o) this.settle(o.value);
      };
      this.buttonList.add(btn);
      return btn;
    });

    this.help = text({ marginTop: 1 });
    for (const node of [this.header, this.body, this.question, this.filterRow, this.list, this.buttonList, this.help]) this.box.add(node);
    this.overlay.add(this.box);
    renderer.root.add(this.overlay);
    renderer.on("resize", () => this.refresh());
  }

  get active() {
    return this.queue.length > 0;
  }

  open(req: MenuRequest) {
    return new Promise<string | null>((resolve) => {
      this.queue.push({ ...req, resolve });
      if (this.queue.length === 1) this.show();
      else this.draw();
    });
  }

  /** Answers the open request and shows the next. */
  settle(value: string | null) {
    const req = this.queue.shift();
    if (value === null) req?.onPreview?.(null);
    req?.resolve(value);
    this.show();
  }

  /** Answers every request as cancelled. */
  cancelAll() {
    for (const p of this.queue.splice(0)) {
      p.onPreview?.(null);
      p.resolve(null);
    }
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

  /** The room for content inside the box: its width less border and padding. */
  private inner(p: Pending) {
    return this.width(p) - (this.centered(p) ? 8 : 4);
  }

  /** The box's outer width: the request's own, within the window; a docked panel spans it. */
  private width(p: Pending) {
    if (!this.centered(p)) return Math.max(30, this.renderer.width);
    return Math.max(30, Math.min(p.width ?? 64, this.renderer.width - 4));
  }

  private fitBody() {
    if (!this.body.visible) return;
    const max = Math.max(4, Math.min(22, Math.floor(this.renderer.height * 0.45)));
    const contentH = Math.max(1, this.bodyContent.height);
    const want = Math.min(max, contentH);
    const scrollable = contentH > max;
    if (this.body.height !== want) this.body.height = want;
    if (this.bodyScrollable !== scrollable) {
      this.bodyScrollable = scrollable;
      this.drawHelp();
    }
  }

  private windowStart() {
    return Math.max(0, Math.min(this.selected - Math.floor(VISIBLE / 2), this.shown.length - VISIBLE));
  }

  private pickRow(rowIndex: number) {
    const o = this.shown[this.windowStart() + rowIndex];
    if (o) this.settle(o.value);
  }

  private move(delta: number) {
    if (!this.shown.length) return;
    this.selected = (this.selected + delta + this.shown.length) % this.shown.length;
    this.draw();
    this.previewSelected();
  }

  private previewSelected() {
    const p = this.queue[0];
    if (!p?.onPreview) return;
    const o = this.shown[this.selected];
    if (o) p.onPreview(o.value);
  }

  private show(reset = true) {
    const p = this.queue[0];
    clearChildren(this.bodyContent);
    this.bodyScrollable = false;
    if (!p) {
      this.overlay.visible = false;
      this.overlay.backgroundColor = "transparent";
      this.onChange(false);
      return;
    }
    const th = this.theme();
    if (reset) {
      this.filter = "";
      this.filterCursor = 0;
      this.tab = 0;
      this.selected = Math.max(0, Math.min(p.initial ?? 0, p.options.length - 1));
    }
    const centered = this.centered(p);
    this.overlay.justifyContent = centered ? "center" : "flex-end";
    this.overlay.alignItems = centered ? "center" : "stretch";
    // A translucent fill over transparent cells would paint over the terminal's background.
    this.overlay.backgroundColor = this.dim() ? DIM_BACKGROUND : "transparent";
    this.box.border = centered ? true : ["top"];
    this.box.borderStyle = centered ? "rounded" : "single";
    this.box.width = centered ? this.width(p) : "auto";
    this.box.backgroundColor = th.bg;
    this.box.borderColor = centered ? th.fgFaint : th.separatorSubtle;
    this.box.paddingX = centered ? 3 : 2;
    const body = p.body?.() ?? [];
    for (const node of body) this.bodyContent.add(node);
    this.body.visible = body.length > 0;
    this.body.scrollTop = 0;
    this.fitBody();
    this.question.content = p.question ?? "";
    this.question.fg = th.fg;
    this.question.visible = !!p.question;
    this.filterRow.visible = !!p.filterable;
    this.list.visible = !p.buttons;
    this.buttonList.visible = !!p.buttons;
    this.overlay.visible = true;
    this.draw();
    this.onChange(true);
  }

  private drawTabs(p: Pending, th: Theme): number {
    clearChildren(this.tabRow);
    if (!p.tabs?.length) {
      this.tabRow.visible = false;
      return 0;
    }
    this.tabRow.visible = true;
    let width = 2;
    this.tabRow.add(new TextRenderable(this.renderer, { content: "  ", fg: th.fgGutter, flexShrink: 0 }));
    p.tabs.forEach((name, i) => {
      if (i) {
        this.tabRow.add(new TextRenderable(this.renderer, { content: " · ", fg: th.fgGutter, flexShrink: 0 }));
        width += 3;
      }
      const active = i === this.tab && !this.filter;
      const node = new TextRenderable(this.renderer, {
        content: active ? styled(bold(fg(th.fg)(name))) : name,
        fg: active ? th.fg : th.fgDim,
        flexShrink: 0,
      });
      node.onMouseDown = () => {
        if (this.filter) {
          this.filter = "";
          this.filterCursor = 0;
        }
        this.tab = i;
        this.selected = 0;
        this.draw();
      };
      this.tabRow.add(node);
      width += name.length;
    });
    return width;
  }

  private draw() {
    const p = this.queue[0];
    if (!p) return;
    const th = this.theme();
    const inner = this.inner(p);
    const tabsWidth = this.drawTabs(p, th);
    const queueBadge = this.queue.length > 1 ? ` (1/${this.queue.length})` : "";
    const titleText = p.title + queueBadge;
    this.title.content = th.mono
      ? styled(bold(fg(th.fg)(p.title)), queueBadge ? fg(th.warning)(queueBadge) : "")
      : styled(...hatchedTitle(th, titleText, inner, tabsWidth));

    // A search looks through every tab; the tabs only split the list while browsing.
    const searching = !!(p.filterable && this.filter);
    const pool = p.tabs?.length && !searching ? p.options.filter((o) => (o.tab ?? p.tabs![0]) === p.tabs![this.tab]) : p.options;
    this.shown = searching ? fuzzyFilter(this.filter, pool, (o) => `${o.label} ${o.hint ?? ""}`, 300) : pool;
    this.selected = Math.max(0, Math.min(this.selected, this.shown.length - 1));

    this.filterRow.content = this.filter
      ? styled(fg(th.fgDim)(`${G.prompt} `), ...filterWithCursor(th, this.filter, this.filterCursor))
      : styled(fg(th.fgDim)(`${G.prompt} `), ...placeholderWithCursor(th, p.placeholder ?? "Type to filter"));

    if (p.buttons) {
      this.buttons.forEach((btn, i) => {
        const o = this.shown[i];
        btn.visible = !!o;
        if (!o) return;
        const on = i === this.selected;
        const keyTag = o.key ? `[${o.key}] ` : "";
        const label = ` ${i + 1}  ${keyTag}${o.label} `.slice(0, inner);
        btn.content = styled(on ? bold(bg(th.primary)(fg(th.onPrimary)(label))) : bg(th.bgRaised)(fg(th.fg)(label)));
      });
    }

    const start = this.windowStart();
    this.rows.forEach((row, i) => {
      const o = this.shown[start + i];
      row.box.visible = !!o && !p.buttons;
      if (!o) return;
      const on = start + i === this.selected;
      const number = p.filterable || p.tabs ? "" : `${start + i + 1}. `;
      const text = number + o.label;
      const match = searching ? fuzzyMatch(this.filter, o.label) : null;
      const shifted = match ? match.indices.map((idx) => idx + number.length) : [];
      row.box.backgroundColor = on ? th.bgRaised : "transparent";
      row.label.content = styled(
        fg(on ? th.fg : th.fgGutter)(on ? `${G.select} ` : "  "),
        ...highlightMatches(text, shifted, on ? th.fg : th.fgDim, th.mono ? th.info : th.secondary, on),
      );
      row.hint.content = o.hint ?? "";
      row.hint.fg = on ? th.fgSubtle : th.fgGutter;
    });
    if (!this.shown.length && !p.buttons) {
      const row = this.rows[0]!;
      row.box.visible = true;
      row.box.backgroundColor = "transparent";
      row.label.content = styled(fg(th.fgDim)("  No matches"));
      row.hint.content = "";
    }

    this.drawHelp();
  }

  private drawHelp() {
    const p = this.queue[0];
    if (!p) return;
    const th = this.theme();
    const inner = this.inner(p);
    const keys: [string, string][] = [];
    if (p.tabs && p.tabs.length > 1 && !this.filter) keys.push(["tab", "switch list"]);
    if (p.passthrough && this.filter) keys.push(["space", "add arguments"]);
    if (p.buttons) {
      keys.push([`1–${this.shown.length}`, "choose"], ["↑↓", "options"]);
      if (this.bodyScrollable) keys.push(["pgup/dn", "scroll diff"]);
      for (const o of this.shown) if (o.key) keys.push([o.key, (o.short ?? o.label).toLowerCase()]);
    } else keys.push(["↑↓", "choose"]);
    keys.push(["enter", "confirm"], ["esc", "cancel"]);
    if (this.shown.length > VISIBLE) keys.push([`${this.selected + 1}/${this.shown.length}`, ""]);
    this.help.content = helpLine(th, keys, inner);
  }

  /** Handles a key while a request is open. Esc and Ctrl+C dismiss it, answering null. */
  handleKey(key: KeyEvent): void {
    const p = this.queue[0];
    if (!p) return;
    if (key.name === "escape" || (key.ctrl && key.name === "c")) return this.settle(null);
    if (key.name === "tab" && p.tabs && p.tabs.length > 1 && !this.filter) {
      this.tab = (this.tab + (key.shift ? -1 : 1) + p.tabs.length) % p.tabs.length;
      this.selected = 0;
      return this.draw();
    }
    if (this.bodyScrollable && (key.name === "pageup" || key.name === "pagedown") && (p.buttons || key.shift)) {
      this.body.scrollBy(key.name === "pageup" ? -0.5 : 0.5, "viewport");
      return;
    }
    const back = key.name === "up" || (key.ctrl && key.name === "p") || (!!p.buttons && (key.name === "left" || (key.name === "tab" && key.shift)));
    const forward = key.name === "down" || (key.ctrl && key.name === "n") || key.name === "tab" || (!!p.buttons && key.name === "right");
    if (back) return this.move(-1);
    if (forward) return this.move(1);
    if (key.name === "pageup") return this.move(-Math.min(VISIBLE, this.selected));
    if (key.name === "pagedown") return this.move(Math.min(VISIBLE, Math.max(0, this.shown.length - 1 - this.selected)));
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
      if (this.editFilter(key)) {
        this.selected = 0;
        this.draw();
        this.previewSelected();
      }
      return;
    }
    const byKey = this.shown.find((o) => o.key && o.key === key.name);
    if (byKey) return this.settle(byKey.value);
    const n = Number(key.name);
    if (Number.isInteger(n) && n >= 1 && n <= this.shown.length) this.settle(this.shown[n - 1]!.value);
  }

  private editFilter(key: KeyEvent): boolean {
    if (key.name === "left") {
      this.filterCursor = Math.max(0, this.filterCursor - 1);
      return true;
    }
    if (key.name === "right") {
      this.filterCursor = Math.min(this.filter.length, this.filterCursor + 1);
      return true;
    }
    if (key.name === "home" || (key.ctrl && key.name === "a")) {
      this.filterCursor = 0;
      return true;
    }
    if (key.name === "end" || (key.ctrl && key.name === "e")) {
      this.filterCursor = this.filter.length;
      return true;
    }
    if (key.name === "backspace" && !key.meta) {
      if (!this.filterCursor) return false;
      this.filter = this.filter.slice(0, this.filterCursor - 1) + this.filter.slice(this.filterCursor);
      this.filterCursor--;
      return true;
    }
    if (key.name === "delete") {
      if (this.filterCursor >= this.filter.length) return false;
      this.filter = this.filter.slice(0, this.filterCursor) + this.filter.slice(this.filterCursor + 1);
      return true;
    }
    if ((key.ctrl && key.name === "w") || (key.meta && key.name === "backspace")) {
      const before = this.filter.slice(0, this.filterCursor);
      const cut = before.replace(/\S+\s*$|^\s+$/, "");
      if (cut.length === before.length) return false;
      this.filter = cut + this.filter.slice(this.filterCursor);
      this.filterCursor = cut.length;
      return true;
    }
    if (key.ctrl && key.name === "u") {
      this.filter = "";
      this.filterCursor = 0;
      return true;
    }
    if (key.ctrl && key.name === "k") {
      this.filter = this.filter.slice(0, this.filterCursor);
      return true;
    }
    if (!key.ctrl && !key.meta && key.sequence && key.sequence.length === 1 && key.sequence >= " ") {
      this.filter = this.filter.slice(0, this.filterCursor) + key.sequence + this.filter.slice(this.filterCursor);
      this.filterCursor++;
      return true;
    }
    return false;
  }
}

/** Renders the filter text with an inverted cursor cell at `cursor`. */
function filterWithCursor(th: Theme, text: string, cursor: number): TextChunk[] {
  const before = text.slice(0, cursor);
  const at = text[cursor] ?? " ";
  const after = text.slice(cursor + 1);
  return [fg(th.fg)(before), bg(th.fg)(fg(th.bg)(at)), ...(after ? [fg(th.fg)(after)] : [])];
}

/** A placeholder whose first character carries the cursor. */
function placeholderWithCursor(th: Theme, text: string): TextChunk[] {
  return [bg(th.fgSubtle)(fg(th.bg)(text[0] ?? " ")), fg(th.fgGutter)(text.slice(1))];
}

/** "key desc • key desc", cut to `width` cells. */
function helpLine(th: Theme, keys: [string, string][], width: number): StyledText {
  const parts: TextChunk[] = [];
  let used = 0;
  for (const [k, d] of keys) {
    const sep = parts.length ? (th.mono ? "  " : " · ") : "";
    const len = sep.length + k.length + (d ? d.length + 1 : 0);
    if (used + len > width) {
      parts.push(fg(th.fgGutter)(" …"));
      break;
    }
    if (sep) parts.push(fg(th.fgGutter)(sep));
    parts.push(th.mono ? fg(th.fgSubtle)(k) : bold(fg(th.fgSubtle)(k)));
    if (d) parts.push(fg(th.fgDim)(" " + d));
    used += len;
  }
  return styled(...parts);
}
