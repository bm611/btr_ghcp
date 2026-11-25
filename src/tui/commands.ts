import { fg } from "@opentui/core";
import { resolve } from "node:path";
import { AGENT_LOG } from "../agent/connection";
import { choices } from "../agent/config-options";
import { copyText } from "../core/clipboard";
import { errorText, formatDuration, formatTokens, oneLine, tildify, trunc } from "../core/format";
import { toolHeader } from "../core/tools";
import type { MenuOption } from "../ui/menu";
import { hatchedTitle, styled } from "../ui/text";
import { themes } from "../ui/theme";
import { VERSION } from "../version";
import type { App } from "./app";
import { SETTINGS_FILE, type Settings, saveSettings } from "./settings";

/**
 * One of btr's own commands. Each is listed in the palette under its `label`; `slash`
 * names also make it a typed /command (whatever follows the name is `args`), and `key`
 * binds a shortcut that runs it with no args (see keys.ts) and shows in the palette.
 */
export type Command = {
  id: string;
  label: string;
  key?: string;
  slash?: string[];
  /** Shown in the palette when there is no key. */
  hint?: string;
  run: (args: string) => unknown;
};

export type Commands = ReturnType<typeof createCommands>;

export function createCommands(app: App) {
  const { settings, transcript } = app;
  const flash: App["chrome"]["flash"] = (...a) => app.chrome.flash(...a);

  const list: Command[] = [
    { id: "new", label: "New Session", key: "ctrl+n", slash: ["new", "clear"], run: () => app.conversation.newSession() },
    {
      id: "sessions",
      label: "Sessions",
      key: "ctrl+s",
      slash: ["sessions", "resume"],
      run: (args) => (args ? app.conversation.loadSession(args) : app.conversation.pickSession()),
    },
    {
      id: "model",
      label: "Switch Model",
      key: "ctrl+l",
      slash: ["model"],
      run: async (args) => {
        if (!args) return app.options.pick("model");
        if (await app.options.setByName("model", args)) flash(`Model: ${app.options.modelName()}`, "success");
        else app.conversation.passToAgent(`/model ${args}`);
      },
    },
    {
      id: "mode",
      label: "Switch Agent Mode",
      key: "shift+tab",
      slash: ["mode"],
      run: async (args) => {
        if (!args) return app.options.pick("mode");
        if (!(await app.options.setByName("mode", args))) flash(`No mode matches "${args}"`, "warning");
      },
    },
    { id: "yolo", label: "Toggle Tool Permissions", key: "ctrl+y", slash: ["permissions", "yolo"], run: () => app.options.toggleYolo() },
    { id: "sidebar", label: "Toggle Sidebar", key: "ctrl+b", slash: ["sidebar"], run: () => app.chrome.toggleSidebar() },
    { id: "details", label: "Toggle Details", key: "ctrl+d", slash: ["details", "verbose"], run: () => app.chrome.toggleVerbose() },
    { id: "todos", label: "Toggle To-Dos", key: "ctrl+t", slash: ["todos"], run: () => app.chrome.toggleTodos() },
    { id: "help", label: "Toggle Help", key: "ctrl+g", slash: ["keys"], run: () => app.chrome.toggleHelp() },
    { id: "editor", label: "Open External Editor", key: "ctrl+o", slash: ["editor"], run: () => app.prompt.editExternally() },
    { id: "history", label: "Search Prompt History", key: "ctrl+r", run: () => app.prompt.searchHistory() },
    { id: "image", label: "Paste Image", key: "ctrl+v", run: () => app.prompt.pasteImage() },
    { id: "stash", label: "Stash Prompt", key: "alt+s", run: () => app.prompt.toggleStash() },
    { id: "copy", label: "Copy Last Reply", slash: ["copy"], run: copyLastReply },
    { id: "find", label: "Search Transcript", key: "ctrl+f", slash: ["find", "search"], run: searchTranscript },
    { id: "wrap", label: "Toggle Diff Wrap", slash: ["wrap"], run: toggleDiffWrap },
    { id: "export", label: "Export Conversation", hint: "markdown", slash: ["export"], run: exportConversation },
    { id: "diff", label: "Show Git Diff", slash: ["diff"], run: showDiff },
    { id: "status", label: "Session Info", slash: ["status"], run: showStatus },
    { id: "cost", label: "Usage", slash: ["cost"], run: showCost },
    {
      id: "init",
      label: "Initialize Project",
      hint: "AGENTS.md",
      run: () =>
        app.conversation.passToAgent(
          app.conversation.agentHas("init") ? "/init" : "Create an AGENTS.md describing this project's layout, build and test commands, and conventions.",
        ),
    },
    {
      id: "compact",
      label: "Compact Conversation",
      run: () => (app.conversation.agentHas("compact") ? app.conversation.passToAgent("/compact") : flash("This agent has no /compact", "warning")),
    },
    { id: "theme", label: "Themes", slash: ["theme"], run: pickTheme },
    { id: "background", label: "Toggle Background Color", run: toggleBackground },
    { id: "markdown", label: "Markdown Style", slash: ["markdown"], run: pickMarkdownStyle },
    { id: "notify", label: "Toggle Notifications", run: toggleNotifications },
    { id: "commands", label: "List Commands", slash: ["help"], run: showHelpBlock },
    { id: "login", label: "Sign In", slash: ["login"], run: showLogin },
    { id: "quit", label: "Quit", key: "ctrl+c", slash: ["quit", "exit"], run: quit },
  ];

  const byId = (id: string) => list.find((c) => c.id === id);
  const bySlash = (name: string) => list.find((c) => c.slash?.includes(name));

  /** Runs a command, reporting a failure in the status line. */
  async function run(command: Command, args = "", name = command.label) {
    try {
      await command.run(args);
    } catch (err) {
      flash(`${name} failed: ${errorText(err)}`, "error");
    }
  }

  /**
   * Runs a typed "/name args" if it is one of btr's commands, or flags a name nobody
   * knows. False when it is the agent's to handle.
   */
  async function runSlash(value: string): Promise<boolean> {
    const [name = "", ...rest] = value.slice(1).split(/\s+/);
    const command = bySlash(name);
    if (command) {
      await run(command, rest.join(" "), `/${name}`);
      return true;
    }
    if (!app.conversation.agentHas(name) && /^\/[\w-]+$/.test(value.split(/\s/)[0]!)) {
      flash(`Unknown command /${name} · ctrl+p lists them`, "warning");
      return true;
    }
    return false;
  }

  /** The command palette: btr's commands, and the agent's on a second tab. */
  async function openPalette() {
    if (app.menus.active) return;
    const agentCommands = app.conversation.commands;
    const options: MenuOption[] = list.map((c) => ({ label: c.label, value: `action:${c.id}`, hint: c.key ?? c.hint, tab: "System" }));
    for (const c of agentCommands) {
      if (bySlash(c.name)) continue;
      options.push({ label: `/${c.name}`, value: `agent:${c.name}`, hint: trunc(c.description.split(/\.\s/)[0]!.replace(/\.$/, ""), 40), tab: "Agent" });
    }
    const value = await app.menus.open({
      title: "Commands",
      options,
      tabs: agentCommands.length ? ["System", "Agent"] : undefined,
      filterable: true,
      placeholder: "Type a command",
      passthrough: true,
      width: 80,
    });
    if (!value) return;
    // "/name args": what was typed goes back to the prompt as a slash command to finish.
    if (value.startsWith("text:")) return app.prompt.setInput(`/${value.slice(5)}`);
    if (value.startsWith("space:")) {
      const picked = value.slice(6);
      const command = picked.startsWith("action:") ? byId(picked.slice(7)) : undefined;
      const name = picked.startsWith("agent:") ? picked.slice(6) : command?.slash?.[0];
      if (name) return app.prompt.setInput(`/${name} `);
      // A command without a slash name has no arguments to take: run it as Enter would.
      if (command) await run(command);
      return;
    }
    if (value.startsWith("action:")) {
      const command = byId(value.slice(7));
      if (command) await run(command);
      return;
    }
    const name = value.slice(6);
    // Commands that take input go to the prompt to be finished; the rest run now.
    if (agentCommands.find((c) => c.name === name)?.input) app.prompt.setInput(`/${name} `);
    else app.conversation.passToAgent(`/${name}`);
  }

  // ── what the commands do ────────────────────────────────────────────────
  /** Copies with the system clipboard, else through the terminal (OSC 52). */
  async function copy(text: string) {
    return (await copyText(text)) || app.renderer.copyToClipboardOSC52(text);
  }

  /** A titled table of rows in the transcript. */
  function infoBlock(title: string, rows: [string, string][], footer = "") {
    const th = app.look.th;
    const width = Math.max(...rows.map(([k]) => k.length)) + 3;
    transcript.add({
      type: "block",
      text: styled(
        ...hatchedTitle(th, title, Math.min(60, app.renderer.width - 8)),
        "\n\n",
        ...rows.flatMap(([k, v]) => [fg(th.fgDim)(k.padEnd(width)), fg(th.fg)(v + "\n")]),
        footer ? fg(th.fgGutter)(footer) : "",
      ),
    });
  }

  function showHelpBlock() {
    const th = app.look.th;
    const own = list.filter((c) => c.slash).map((c) => [`/${c.slash!.join(", /")}`, c.label + (c.key ? `  ${c.key}` : "")] as const);
    const theirs = app.conversation.commands.filter((c) => !bySlash(c.name));
    const width = Math.max(...own.map(([k]) => k.length)) + 2;
    transcript.add({
      type: "block",
      text: styled(
        ...hatchedTitle(th, `btr ${VERSION}`, Math.min(60, app.renderer.width - 8)),
        "\n\n",
        ...own.flatMap(([k, d]) => [fg(th.primary)(k.padEnd(width)), fg(th.fgMuted)(d + "\n")]),
        "\n",
        fg(th.fgMuted)(
          theirs.length ? `${theirs.length} more come from the agent: ctrl+p, then tab to its list.\n` : "The agent's own commands appear in ctrl+p once it lists them.\n",
        ),
        fg(th.fgDim)("ctrl+g shows every shortcut."),
      ),
    });
  }

  function contextRow(): [string, string][] {
    const { usage } = app.conversation;
    return usage?.size ? [["Context", `${formatTokens(usage.used)} of ${formatTokens(usage.size)} tokens (${app.conversation.contextPct()}%)`]] : [];
  }

  function showStatus() {
    const { agent } = app;
    const rows: [string, string][] = [];
    if (agent) {
      rows.push(["Agent", `${agent.info?.title ?? agent.info?.name ?? "unknown"} ${agent.info?.version ?? ""} (${agent.command})`]);
      rows.push(["Session", agent.sessionId || "none"]);
      for (const o of agent.configOptions) {
        if (o.type === "select") rows.push([o.name, choices(o).find((c) => c.value === o.currentValue)?.name ?? String(o.currentValue)]);
      }
    } else rows.push(["Agent", "not connected"]);
    rows.push(["Directory", tildify(app.cwd)]);
    rows.push(...contextRow());
    rows.push(["Theme", `${settings.theme}${settings.theme === "auto" ? ` (${app.look.th.name})` : ""}`]);
    rows.push(["Settings", tildify(SETTINGS_FILE)]);
    rows.push(["Agent log", AGENT_LOG]);
    infoBlock("Session Info", rows);
  }

  function showCost() {
    const { usage, started, turns } = app.conversation;
    const rows: [string, string][] = [
      ["Duration", formatDuration(Date.now() - started)],
      ["Turns", String(turns)],
      ...contextRow(),
    ];
    if (usage?.cost) rows.push(["Cost", `${usage.cost.amount.toFixed(4)} ${usage.cost.currency}`]);
    const missing = app.conversation.agentHas("usage") ? "The agent has not reported usage yet; its /usage command asks it." : "The agent has not reported usage yet.";
    infoBlock("Usage", rows, usage ? "" : missing);
  }

  async function copyLastReply() {
    const reply = transcript.lastReply();
    if (!reply) return flash("Nothing to copy yet");
    const ok = await copy(reply);
    flash(ok ? "Copied the last reply" : "Could not reach the clipboard", ok ? "success" : "error");
  }

  async function exportConversation(args: string) {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const file = resolve(app.cwd, args || `conversation-${stamp}.md`);
    try {
      await Bun.write(file, transcript.toMarkdown());
      flash(`Saved ${tildify(file)}`, "success", 4000);
    } catch (err) {
      flash(`Could not write ${file}: ${errorText(err)}`, "error");
    }
  }

  async function showDiff() {
    const proc = Bun.spawn(["git", "diff", "HEAD"], { cwd: app.cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if ((await proc.exited) !== 0) return flash(err.trim().split("\n")[0] || "git diff failed", "warning");
    const files = out.split(/^(?=diff --git )/m).filter((f) => f.trim());
    if (!files.length) return flash("No uncommitted changes");
    for (const patch of files.slice(0, 30)) transcript.add({ type: "diff", patch });
    if (files.length > 30) transcript.note(`${files.length - 30} more files changed`);
  }

  async function pickTheme(args: string) {
    const options: MenuOption[] = [
      { label: "Auto", value: "auto", hint: "fx, light or dark by the terminal" },
      ...Object.values(themes).map((t) => ({ label: t.label, value: t.name, hint: t.hint })),
    ];
    const names = options.map((o) => o.value);
    const prev = settings.theme;
    const preview = (v: string | null) => {
      const next = (v ?? prev) as Settings["theme"];
      if (settings.theme === next) return;
      settings.theme = next;
      app.chrome.applyTheme();
    };
    const value =
      args ||
      (await app.menus.open({
        title: "Themes",
        options,
        initial: names.indexOf(prev),
        onPreview: preview,
      }));
    if (!value) {
      preview(null);
      return;
    }
    if (!names.includes(value)) return flash(`Unknown theme "${value}"`, "warning");
    settings.theme = value as Settings["theme"];
    await saveSettings(settings);
    app.chrome.applyTheme();
  }

  async function pickMarkdownStyle(args: string) {
    const prev = settings.markdown;
    const preview = (v: string | null) => {
      const next = (v ?? prev) as Settings["markdown"];
      if (settings.markdown === next) return;
      settings.markdown = next;
      transcript.rebuild();
    };
    const value =
      args ||
      (await app.menus.open({
        title: "Markdown Style",
        options: [
          { label: "Glow", value: "glow", hint: "glow's colors and headings" },
          { label: "btr", value: "btr", hint: "the theme's colors" },
        ],
        initial: prev === "glow" ? 0 : 1,
        onPreview: preview,
      }));
    if (!value) {
      preview(null);
      return;
    }
    if (value !== "glow" && value !== "btr") return flash(`Unknown markdown style "${value}"`, "warning");
    settings.markdown = value;
    await saveSettings(settings);
    transcript.rebuild();
  }

  function toggleDiffWrap() {
    const on = transcript.toggleDiffWrap();
    flash(`Diff wrapping ${on ? "on" : "off"}`);
  }

  async function searchTranscript() {
    const options: MenuOption[] = [];
    transcript.entries.forEach((e, i) => {
      const it = e.item;
      if (it.type === "user") {
        options.push({ label: `> ${oneLine(it.text, 72)}`, value: String(i), hint: it.mode === "prompt" ? "prompt" : it.mode });
      } else if (it.type === "assistant" && it.text.trim()) {
        options.push({ label: oneLine(it.text, 72), value: String(i), hint: "reply" });
      } else if (it.type === "tool") {
        const { name, arg } = toolHeader(it.tool, app.cwd);
        options.push({ label: `${name}${arg ? ` ${arg}` : ""}`, value: String(i), hint: "tool" });
      } else if (it.type === "diff") {
        const file = /^\+\+\+ (?:b\/)?(.+)$/m.exec(it.patch)?.[1]?.trim() ?? "diff";
        options.push({ label: file, value: String(i), hint: "diff" });
      }
    });
    if (!options.length) return flash("Nothing in the transcript yet");
    const picked = await app.menus.open({
      title: "Search Transcript",
      options: options.reverse(),
      filterable: true,
      placeholder: "Jump to message, tool or file",
      width: 90,
    });
    if (picked !== null) {
      const entry = transcript.entries[Number(picked)];
      if (entry) transcript.scrollToEntry(entry);
    }
  }

  function toggleBackground() {
    settings.background = !settings.background;
    void saveSettings(settings);
    app.chrome.applyTheme();
    flash(settings.background ? "Theme background on" : "Using the terminal's background");
  }

  function toggleNotifications() {
    settings.notifications = !settings.notifications;
    void saveSettings(settings);
    flash(`Notifications ${settings.notifications ? "on" : "off"}`);
  }

  function showLogin() {
    const methods = app.agent?.authMethods ?? [];
    transcript.note(
      methods.length ? methods.map((m) => `${m.name}${m.description ? `: ${m.description}` : ""}`).join("\n") : "This agent did not advertise a sign-in method.",
    );
  }

  function quit() {
    app.chrome.stopSpinner();
    app.modes.killShell();
    app.agent?.stop();
    app.renderer.destroy();
    process.exit(0);
  }

  return { list, run, runSlash, openPalette, copy, quit };
}
