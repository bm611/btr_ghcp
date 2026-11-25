import { fg } from "@opentui/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mentionAt, slashAt } from "../core/attachments";
import { listFiles } from "../core/files";
import { trunc, truncStart } from "../core/format";
import { fuzzyFilter, fuzzyMatch } from "../core/fuzzy";
import { highlightMatches, styled } from "../ui/text";
import { G } from "../ui/theme";
import type { InputMode } from "../ui/transcript";
import type { App } from "./app";
import { MODES, type OtherMode, modeOf } from "./modes";
import { MAX_COMPLETIONS } from "./view";

export type Prompt = ReturnType<typeof createPrompt>;

type Completion = {
  label: string;
  hint?: string;
  insert: string;
  isDir?: boolean;
};

/** The prompt: its modes, @ and / completions, attachments, history, pastes, editor and stash. */
export function createPrompt(app: App) {
  const { view, history, attachments, cwd } = app;
  const { input } = view;
  let mode: InputMode = "prompt";
  let stash: string | null = null;
  /** The options offered for the `@mention` or `/command` at the cursor. */
  let matches: Completion[] = [];
  let completionKind: "mention" | "slash" | null = null;
  let completionQuery = "";
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
    const rail = mode === "prompt" ? G.prompt : MODES[mode].rail;
    const color = mode === "prompt" ? th.info : th.fgDim;
    view.promptMark.content = styled(fg(color)(rail), fg(th.fgGutter)(("\n" + (mode === "prompt" ? G.prompt : " ")).repeat(rows - 1)));
    input.placeholder = mode === "prompt" ? "Message the agent… (/ commands, @ files, ? keys)" : MODES[mode].placeholder;
  }

  /** Shows compact chips for `@` files, pasted blocks and images currently in the prompt. */
  function drawAttachments() {
    const desc = mode === "prompt" ? attachments.describe(input.plainText) : { mentions: [], pastes: [], images: [] };
    const chips: string[] = [
      ...desc.mentions.map((m) => `@${truncStart(m, 28)}`),
      ...desc.pastes.map((p) => `Paste #${p.id} (${p.lines}L)`),
      ...desc.images.map((im) => `Image #${im.id} (${im.mimeType.split("/")[1] ?? "img"})`),
    ];
    view.attachmentBar.visible = chips.length > 0;
    if (!chips.length) return;
    const th = app.look.th;
    view.attachmentBar.content = styled(
      fg(th.fgDim)(`${G.model} `),
      ...chips.flatMap((c, i) => (i ? [fg(th.fgGutter)("  ·  "), fg(th.fgSubtle)(c)] : [fg(th.fgSubtle)(c)])),
    );
  }

  // ── @ and / completions ─────────────────────────────────────────────────
  function slashCandidates(): Completion[] {
    const out: Completion[] = [];
    const seen = new Set<string>();
    for (const c of app.commands.list) {
      for (const s of c.slash ?? []) {
        if (seen.has(s)) continue;
        seen.add(s);
        out.push({ label: `/${s}`, hint: c.key ?? c.label, insert: `/${s} ` });
      }
    }
    for (const c of app.conversation.commands) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      const hint = c.description.split(/\.\s/)[0]!.replace(/\.$/, "");
      out.push({ label: `/${c.name}`, hint: trunc(hint, 32), insert: `/${c.name}${c.input ? " " : ""}` });
    }
    return out;
  }

  function updateCompletions() {
    if (dismissed || mode !== "prompt") {
      matches = [];
      completionKind = null;
      completionQuery = "";
      drawCompletions();
      return;
    }
    const text = input.plainText;
    const at = cursorIndex();
    const mention = mentionAt(text, at);
    if (mention) {
      completionKind = "mention";
      completionQuery = mention.query;
      matches = fuzzyFilter(mention.query, listFiles(cwd), (p) => p, 50).map((p) => ({
        label: p,
        hint: p.endsWith("/") ? "dir" : undefined,
        insert: `@${/\s/.test(p) ? `"${p}"` : p}${p.endsWith("/") ? "" : " "}`,
        isDir: p.endsWith("/"),
      }));
    } else {
      const slash = slashAt(text, at);
      const candidates = slash && slash.query.length > 0 ? slashCandidates() : [];
      const exact = slash && candidates.some((c) => c.label === `/${slash.query}`);
      if (slash && slash.query.length > 0 && !exact) {
        completionKind = "slash";
        completionQuery = slash.query;
        matches = fuzzyFilter(slash.query, candidates, (c) => `${c.label.slice(1)} ${c.hint ?? ""}`, 30);
      } else {
        matches = [];
        completionKind = null;
        completionQuery = "";
      }
    }
    selected = Math.min(selected, Math.max(0, matches.length - 1));
    drawCompletions();
  }

  function drawCompletions() {
    const open = matches.length > 0 && !app.menus.active;
    view.completions.visible = open;
    if (!open) return;
    const th = app.look.th;
    const start = Math.max(0, Math.min(selected - Math.floor(MAX_COMPLETIONS / 2), matches.length - MAX_COMPLETIONS));
    const slice = matches.slice(start, start + MAX_COMPLETIONS);
    const maxLabel = Math.max(20, ...slice.map((m) => m.label.length + (m.hint ? m.hint.length + 3 : 0) + 4));
    const width = Math.min(76, maxLabel);
    view.completions.width = width + 2;
    view.completions.border = true;
    view.completions.borderStyle = "single";
    view.completions.borderColor = th.separatorSubtle;
    view.completions.paddingX = 1;
    view.completionRows.forEach((row, i) => {
      const m = matches[start + i];
      row.visible = !!m;
      if (!m) return;
      const on = start + i === selected;
      const hintStr = m.hint ? `  ${m.hint}` : "";
      const avail = Math.max(10, width - 4 - hintStr.length);
      const shownLabel = truncStart(m.label, avail);
      // Match indices only map cleanly when not truncated from the start.
      const match = shownLabel === m.label && completionQuery ? fuzzyMatch(completionQuery, shownLabel) : null;
      const baseColor = on ? th.fg : m.isDir ? th.fgSubtle : th.fgMuted;
      row.bg = on ? th.bgRaised : app.settings.background ? th.bg : "transparent";
      row.content = styled(
        fg(th.fg)(on ? `${G.select} ` : "  "),
        ...highlightMatches(shownLabel, match?.indices ?? [], baseColor, th.mono ? th.info : th.secondary, on),
        hintStr ? fg(th.fgGutter)(hintStr) : "",
      );
      row.onMouseDown = () => {
        selected = start + i;
        completeMention();
      };
    });
  }

  /** Replaces the `@partial` or `/partial` being typed with the selected completion. */
  function completeMention() {
    const m = matches[selected];
    if (!m) return;
    const value = input.plainText;
    const at = cursorIndex();
    const span = completionKind === "slash" ? slashAt(value, at) : mentionAt(value, at);
    if (!span) return;
    input.setText(value.slice(0, span.start) + m.insert + value.slice(at));
    input.cursorOffset = input.editBuffer.stringIndexToCellOffset(span.start + m.insert.length);
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
      drawAttachments();
    } finally {
      changing = false;
    }
  }

  // TextareaRenderable reports edits and Enter through these callbacks; unlike
  // InputRenderable it never emits "input" or "enter" events.
  input.onContentChange = onInputChange;
  input.onCursorChange = () => {
    if (!changing && (input.plainText.includes("@") || input.plainText.startsWith("/"))) updateCompletions();
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
    drawAttachments();
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

  // ── queued messages ─────────────────────────────────────────────────────
  function editQueued(index?: number) {
    const popped = app.conversation.popQueue(index);
    if (popped === undefined) return;
    const cur = input.plainText;
    setInput(cur ? `${popped}\n${cur}` : popped);
    app.chrome.flash("Moved queued message back to prompt");
  }

  function dropQueued(index?: number) {
    const popped = app.conversation.popQueue(index);
    if (popped === undefined) return;
    app.chrome.flash("Dropped queued message");
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
    if (placeholder) {
      input.insertText(placeholder + " ");
      drawAttachments();
    } else app.chrome.flash("No image on the clipboard", "warning");
  }

  /** A bracketed paste: a dragged image file becomes an image, a long text a placeholder. */
  function paste(bytes: Uint8Array) {
    const pasted = new TextDecoder().decode(bytes).replace(/\r\n?/g, "\n");
    void (async () => {
      const image = await attachments.imageFromPath(pasted);
      input.insertText(image ? image + " " : attachments.paste(pasted));
      drawAttachments();
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
    /** Whether @ or / completions are showing. */
    get completing() {
      return matches.length > 0;
    },
    setInput,
    setMode,
    draw,
    drawCompletions,
    drawAttachments,
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
    editQueued,
    dropQueued,
    editExternally,
    pasteImage,
    paste,
    toggleStash,
  };
}
