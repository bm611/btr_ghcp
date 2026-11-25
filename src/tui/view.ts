import { BoxRenderable, type CliRenderer, ScrollBoxRenderable, TextRenderable, TextareaRenderable } from "@opentui/core";

/** Rows of @ or / completions shown at once. */
export const MAX_COMPLETIONS = 8;

export type View = ReturnType<typeof createView>;

/**
 * The layout. A column holds, top to bottom: the start page (while the session is empty), the conversation, the jump-to-bottom pill,
 * the pinned to-dos, the working line, queued messages, attachments, completions, the
 * prompt, the shortcut panel and the status line; the sidebar sits beside it. This only
 * builds the nodes: the other modules fill them in.
 */
export function createView(renderer: CliRenderer) {
  const text = (extra: Record<string, unknown> = {}) => new TextRenderable(renderer, { content: "", flexShrink: 0, ...extra });

  const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%" });
  renderer.root.add(root);

  const body = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, flexShrink: 1 });
  root.add(body);

  const main = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, flexShrink: 1 });
  body.add(main);

  // The start page (dashboard.ts): it fills the room above the prompt while the session is empty.
  const dashboard = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
    visible: false,
  });
  main.add(dashboard);

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
  const list = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0, gap: 1, paddingTop: 1, paddingBottom: 1 });
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

  const scrollJump = text({ marginTop: 0, paddingX: 2, visible: false, wrapMode: "none", truncate: true });
  scrollJump.onMouseDown = () => scroll.scrollTo(Infinity);
  const todoPanel = text({ marginTop: 1, paddingX: 2, visible: false });
  const spinner = text({ marginTop: 1, paddingX: 2, visible: false, wrapMode: "none", truncate: true });
  const queued = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0, marginTop: 1, paddingX: 2, visible: false });
  const attachmentBar = text({ marginTop: 1, paddingX: 2, visible: false, wrapMode: "none", truncate: true });
  for (const n of [scrollJump, todoPanel, spinner, queued, attachmentBar]) main.add(n);

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
    // chrome.ts sizes it to the window.
    width: 36,
    border: ["left"],
    paddingX: 1,
    paddingTop: 1,
  });
  const sidebarScroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    verticalScrollbarOptions: { visible: false },
    contentOptions: { flexDirection: "column" },
  });
  const sidebarHead = text({ flexShrink: 0 });
  const sidebarFiles = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0 });
  const sidebarFoot = text({ flexShrink: 0 });
  sidebarScroll.add(sidebarHead);
  sidebarScroll.add(sidebarFiles);
  sidebarScroll.add(sidebarFoot);
  sidebar.add(sidebarScroll);
  body.add(sidebar);

  const helpPanel = text({ paddingX: 2, paddingY: 1, visible: false, wrapMode: "none", truncate: true });
  main.add(helpPanel);

  const status = new BoxRenderable(renderer, {
    flexDirection: "row",
    flexShrink: 0,
    paddingX: 2,
    paddingBottom: 1,
  });
  const statusText = text({ flexGrow: 1, flexShrink: 1, wrapMode: "none", truncate: true });
  const statusContext = text({ flexShrink: 0, marginLeft: 2, wrapMode: "none", truncate: true });
  status.add(statusText);
  status.add(statusContext);
  main.add(status);
  // Takes up whatever room is left below the prompt; the dashboard takes it instead.
  const filler = new BoxRenderable(renderer, { flexGrow: 1, flexShrink: 1, minHeight: 0 });
  main.add(filler);

  return {
    root,
    dashboard,
    filler,
    scroll,
    list,
    scrollJump,
    todoPanel,
    spinner,
    queued,
    attachmentBar,
    completions,
    completionRows,
    promptMark,
    input,
    sidebar,
    sidebarHead,
    sidebarFiles,
    sidebarFoot,
    helpPanel,
    status,
    statusText,
    statusContext,
  };
}
