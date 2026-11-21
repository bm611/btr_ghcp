import type { KeyEvent } from "@opentui/core";
import type { App } from "./app";

/** The shortcut panel (ctrl+g, or ? on an empty prompt), read down three columns. */
export const HELP_KEYS: [key: string, does: string][] = [
  ["ctrl+p", "commands"],
  ["/", "commands (empty prompt)"],
  ["@", "mention a file"],
  ["!", "shell mode"],
  ["#", "save a note"],
  ["shift+enter", "newline"],
  ["ctrl+n", "new session"],
  ["ctrl+s", "sessions"],
  ["ctrl+l", "switch model"],
  ["shift+tab", "cycle mode"],
  ["ctrl+y", "yolo mode"],
  ["esc", "interrupt"],
  ["ctrl+d", "toggle details"],
  ["ctrl+b", "toggle sidebar"],
  ["ctrl+t", "pin to-dos"],
  ["ctrl+o", "open $EDITOR"],
  ["ctrl+r", "search history"],
  ["ctrl+v", "paste image"],
];
export const HELP_FOOTER = "ctrl+g to close · alt+s stash · ctrl+c twice to quit · pgup/pgdn scroll";

/** A key as bindings write it: "ctrl+n", "alt+s", "shift+tab". */
export function chord(key: Pick<KeyEvent, "name" | "ctrl" | "meta" | "shift">) {
  return [key.ctrl && "ctrl", key.meta && "alt", key.shift && "shift", key.name].filter(Boolean).join("+");
}

/**
 * Handles every key before the prompt sees it. An open dialog takes them all. Then come the
 * keys whose meaning depends on what is going on (ctrl+c, esc, tab, enter, the arrows), then
 * the bindings: the few below, and every command's `key` from commands.ts.
 */
export function bindKeys(app: App) {
  const { renderer, view } = app;
  let lastCtrlC = 0;
  let lastEsc = 0;

  async function suspend() {
    await renderer.suspend();
    process.once("SIGCONT", () => {
      void renderer.resume().then(() => view.input.focus());
    });
    process.kill(process.pid, "SIGTSTP");
  }

  // Keys that are not a command's, or that do something else than their command does
  // from the palette: shift+tab cycles modes where "Switch Mode" opens a list.
  const bindings = new Map<string, () => unknown>([
    ["ctrl+p", () => app.commands.openPalette()],
    ["shift+tab", () => app.options.cycleMode()],
    ["ctrl+z", suspend],
  ]);
  for (const command of app.commands.list) {
    if (command.key && !bindings.has(command.key)) bindings.set(command.key, () => app.commands.run(command));
  }

  function onKey(key: KeyEvent) {
    const { prompt, conversation, chrome, modes, menus } = app;
    if (menus.active) {
      key.preventDefault();
      menus.handleKey(key);
      return;
    }

    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (modes.shellRunning) return modes.killShell();
      if (prompt.text) return prompt.discard();
      if (conversation.busy) return conversation.interrupt();
      if (Date.now() - lastCtrlC < 1500) return app.commands.quit();
      lastCtrlC = Date.now();
      return chrome.flash("Press ctrl+c again to quit", "warning", 1500);
    }

    if (key.name === "escape") {
      key.preventDefault();
      if (prompt.completing) return prompt.dismissCompletions();
      if (chrome.helpShown) return chrome.toggleHelp();
      if (modes.shellRunning) return modes.killShell();
      if (prompt.mode !== "prompt" && !prompt.text) return prompt.setMode("prompt");
      if (conversation.busy) return conversation.interrupt();
      if (!prompt.text) return;
      if (Date.now() - lastEsc < 800) {
        prompt.discard();
        lastEsc = 0;
        return chrome.flash("");
      }
      lastEsc = Date.now();
      return chrome.flash("Esc again to clear the prompt", "info", 800);
    }

    if (key.name === "tab" && !key.shift) {
      key.preventDefault();
      if (prompt.completing) prompt.completeMention();
      return;
    }

    if (key.name === "backspace" && !prompt.text && prompt.mode !== "prompt") {
      key.preventDefault();
      return prompt.setMode("prompt");
    }

    const plain = !key.shift && !key.meta && !key.ctrl;
    if ((key.name === "return" || key.name === "kpenter") && plain) {
      // A trailing backslash continues the prompt on a new line.
      if (prompt.continueLine()) return key.preventDefault();
      if (prompt.completing) {
        key.preventDefault();
        return prompt.completeMention();
      }
    }

    if (key.name === "up" || key.name === "down") {
      const dir = key.name === "up" ? -1 : 1;
      if (prompt.completing) {
        key.preventDefault();
        return prompt.moveCompletion(dir);
      }
      if (plain && prompt.atEdge(dir < 0 ? "top" : "bottom")) {
        if (prompt.historyStep(dir)) key.preventDefault();
        return;
      }
    }

    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      return view.scroll.scrollBy(key.name === "pageup" ? -0.5 : 0.5, "viewport");
    }
    if (key.name === "end" && key.ctrl) {
      key.preventDefault();
      return view.scroll.scrollTo(Infinity);
    }

    const bound = bindings.get(chord(key));
    if (bound) {
      key.preventDefault();
      void bound();
    }
  }

  renderer.keyInput.on("keypress", onKey);
  renderer.keyInput.on("paste", (event) => {
    event.preventDefault();
    if (!app.menus.active) app.prompt.paste(event.bytes);
  });
}
