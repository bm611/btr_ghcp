import { bold, fg } from "@opentui/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mentionAt } from "../core/attachments";
import { listFiles } from "../core/files";
import { truncStart } from "../core/format";
import { fuzzyFilter } from "../core/fuzzy";
import { styled } from "../ui/text";
import { G } from "../ui/theme";
import type { InputMode } from "../ui/transcript";
import type { App } from "./app";
import { MODES, type OtherMode, modeOf } from "./modes";
import { MAX_COMPLETIONS } from "./view";

export type Prompt = ReturnType<typeof createPrompt>;

/** The prompt: its modes, @ completions, history, pastes, the external editor and the stash. */
export function createPrompt(app: App) {
  const { view, history, attachments, cwd } = app;
  const { input } = view;
  let mode: InputMode = "prompt";
  let stash: string | null = null;
  /** The paths offered for the @mention at the cursor. */
  let matches: string[] = [];
  let selected = 0;
  let dismissed = false;
  /** Set while the prompt changes its own text, so the change is not taken as typing. */
  let changing = false;

  /** Typed alone on an empty prompt, these do something instead of being typed. */
  const shortcuts = new Map<string, () => void>([
    ["/", () => void app.commands.openPalette()],
    ["?", () => app.chrome.toggleHelp()],
  ]);
  const triggers = new Map((Object.keys(MODES) as OtherMode[]).map((m) => [MODES[m].trigger, m]));

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

  function setMode(next: InputMode) {
    mode = next;
    draw();
    app.chrome.drawStatus();
  }

  /** fx's prompt is a bright rail beside the text; the other modes swap it for their own mark. */
  function draw() {
    const th = app.look.th;
    const rows = Math.max(1, input.height);
    const rail = mode === "prompt" ? G.rail : MODES[mode].rail;
    const color = mode === "prompt" ? th.fg : th.fgMuted;
    view.promptMark.content = styled(fg(color)(rail), fg(th.fgFaint)(("\n" + (mode === "prompt" ? G.rail : " ")).repeat(rows - 1)));
    input.placeholder = mode === "prompt" ? "" : MODES[mode].placeholder;
  }

  // ── @ completions ───────────────────────────────────────────────────────
  function updateCompletions() {
    const mention = !dismissed && mode === "prompt" ? mentionAt(input.plainText, cursorIndex()) : null;
    matches = mention ? fuzzyFilter(mention.query, listFiles(cwd), (p) => p, 50) : [];
    selected = Math.min(selected, Math.max(0, matches.length - 1));
    drawCompletions();
  }

  function drawCompletions() {
    const open = matches.length > 0 && !app.menus.active;
    view.completions.visible = open;
    if (!open) return;
    const th = app.look.th;
    const start = Math.max(0, Math.min(selected - Math.floor(MAX_COMPLETIONS / 2), matches.length - MAX_COMPLETIONS));
    const width = Math.min(70, Math.max(24, ...matches.slice(start, start + MAX_COMPLETIONS).map((m) => m.length + 4)));
    view.completions.width = width + 2;
    view.completionRows.forEach((row, i) => {
      const m = matches[start + i];
      row.visible = !!m;
      if (!m) return;
      const on = start + i === selected;
      row.bg = app.settings.background ? th.bg : "transparent";
      row.content = styled(
        fg(th.fg)(on ? `${G.select} ` : "  "),
        (on ? (t: string) => bold(fg(th.fg)(t)) : fg(m.endsWith("/") ? th.fgSubtle : th.fgMuted))(truncStart(m, width - 4)),
      );
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

  // ── typing ──────────────────────────────────────────────────────────────
  /** Grows the prompt with its content, up to a dozen rows. */
  function fitInput() {
    const rows = Math.max(1, Math.min(12, Math.max(input.lineCount, input.virtualLineCount)));
    if (input.height !== rows) input.height = rows;
    draw();
  }

  function onInputChange() {
    if (changing) return;
    changing = true;
    try {
      const value = input.plainText;
      const entered = mode === "prompt" ? triggers.get(value) : undefined;
      const shortcut = mode === "prompt" ? shortcuts.get(value) : undefined;
      if (entered) {
        input.setText("");
        setMode(entered);
      } else if (shortcut) {
        input.setText("");
        shortcut();
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
    if (app.menus.active) return;
    const value = input.plainText.trim();
    if (!value) return;
    const submitted = mode;
    input.setText("");
    if (submitted !== "prompt") setMode("prompt");
    onInputChange();
    history.add(submitted === "prompt" ? value : MODES[submitted].trigger + value);
    if (submitted !== "prompt") return app.modes.run(submitted, value);
    if (value.startsWith("/") && (await app.commands.runSlash(value))) return;
    if (app.conversation.disconnected) return app.chrome.flash("The agent is disconnected; restart btr to continue", "error");
    app.conversation.passToAgent(value);
  }

  // ── history ─────────────────────────────────────────────────────────────
  /** Puts a history entry in the prompt, restoring the mode it was typed in. */
  function recall(entry: string) {
    const typedIn = modeOf(entry) ?? "prompt";
    if (typedIn !== mode) setMode(typedIn);
    // Set directly: a recalled "/" or "!" must not switch modes again.
    changing = true;
    input.setText(typedIn === "prompt" ? entry : entry.slice(MODES[typedIn].trigger.length));
    input.gotoBufferEnd();
    changing = false;
    fitInput();
    setTimeout(fitInput, 0);
    matches = [];
    drawCompletions();
  }

  /** Steps back (-1) or forward (+1) through the history; false at either end. */
  function historyStep(dir: -1 | 1) {
    const entry = dir < 0 ? history.prev(mode === "prompt" ? input.plainText : MODES[mode].trigger + input.plainText) : history.next();
    if (entry === null) return false;
    recall(entry);
    return true;
  }

  async function searchHistory() {
    const all = history.all();
    if (!all.length) return app.chrome.flash("No prompt history yet");
    const value = await app.menus.open({
      title: "Prompt History",
      options: all.map((h, i) => ({ label: h.replace(/\s*\n\s*/g, " ⏎ ").slice(0, 100), value: String(i) })),
      filterable: true,
      placeholder: "Search history",
      width: 90,
    });
    if (value !== null) recall(all[Number(value)]!);
  }

  // ── more ways to fill the prompt ────────────────────────────────────────
  async function editExternally() {
    const { renderer } = app;
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

  async function pasteImage() {
    const placeholder = await attachments.imageFromClipboard();
    if (placeholder) input.insertText(placeholder + " ");
    else app.chrome.flash("No image on the clipboard", "warning");
  }

  /** A bracketed paste: a dragged image file becomes an image, a long text a placeholder. */
  function paste(bytes: Uint8Array) {
    const pasted = new TextDecoder().decode(bytes).replace(/\r\n?/g, "\n");
    void (async () => {
      const image = await attachments.imageFromPath(pasted);
      input.insertText(image ? image + " " : attachments.paste(pasted));
    })();
  }

  function toggleStash() {
    if (stash !== null && !input.plainText) {
      setInput(stash);
      stash = null;
    } else if (input.plainText) {
      stash = input.plainText;
      setInput("");
      app.chrome.flash("Prompt stashed · alt+s on an empty prompt restores it");
    } else app.chrome.flash("Nothing to stash");
    app.chrome.drawStatus();
  }

  return {
    get mode() {
      return mode;
    },
    get text() {
      return input.plainText;
    },
    get stash() {
      return stash;
    },
    /** Whether @ completions are showing. */
    get completing() {
      return matches.length > 0;
    },
    setInput,
    setMode,
    draw,
    drawCompletions,
    completeMention,
    moveCompletion(delta: number) {
      selected = (selected + delta + matches.length) % matches.length;
      drawCompletions();
    },
    dismissCompletions() {
      dismissed = true;
      updateCompletions();
    },
    /** Clears the prompt, keeping its text in the history, and leaves any mode. */
    discard() {
      history.add(input.plainText);
      setInput("");
      if (mode !== "prompt") setMode("prompt");
    },
    /** Turns a backslash before the cursor into a new line, as a shell does; false when there is none. */
    continueLine() {
      if (!input.plainText.slice(0, cursorIndex()).endsWith("\\")) return false;
      input.deleteCharBackward();
      input.newLine();
      return true;
    },
    /** True when the cursor is on the first (or last) row, so ↑/↓ leave the text for the history. */
    atEdge(edge: "top" | "bottom") {
      const rows = input.virtualLineCount;
      if (rows <= 1) return true;
      const row = input.visualCursor.visualRow + input.scrollY;
      return edge === "top" ? row <= 0 : row >= rows - 1;
    },
    historyStep,
    searchHistory,
    editExternally,
    pasteImage,
    paste,
    toggleStash,
  };
}
