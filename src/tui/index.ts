import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { AGENT_LOG, startAgent } from "../agent/connection";
import { Attachments } from "../core/attachments";
import { listFiles } from "../core/files";
import { errorText } from "../core/format";
import { Menus } from "../ui/menu";
import { Transcript } from "../ui/transcript";
import type { App } from "./app";
import { createChrome } from "./chrome";
import { createCommands } from "./commands";
import { createConversation } from "./conversation";
import { createDashboard } from "./dashboard";
import { History } from "./history";
import { bindKeys } from "./keys";
import { Look } from "./look";
import { createModes } from "./modes";
import { createOptions } from "./options";
import { createPrompt } from "./prompt";
import { loadSettings } from "./settings";
import { createView } from "./view";

export type TuiOptions = {
  cwd: string;
  /** Sent as the first prompt. */
  prompt?: string;
  /** A session id to load, or true to pick one. */
  resume?: string | boolean;
  /** Load the most recent session for this directory. */
  continueLast?: boolean;
  model?: string;
  mode?: string;
  /** A renderer to draw into instead of the terminal (tests). */
  renderer?: CliRenderer;
};

/** Opens the interface, starts the agent and its first session, and returns once both are up. */
export async function runTui(opts: TuiOptions): Promise<App> {
  const { cwd } = opts;
  const settings = await loadSettings();
  const history = await History.load(cwd);
  const renderer = opts.renderer ?? (await createCliRenderer({ exitOnCtrlC: false, screenMode: "alternate-screen" }));
  const look = await Look.create(renderer, settings);
  const view = createView(renderer);

  const app = { cwd, renderer, settings, history, attachments: new Attachments(), agent: null, look, view } as App;
  app.transcript = new Transcript(renderer, view.scroll, view.list, {
    theme: () => look.th,
    syntax: () => look.syntax,
    markdown: () => ({ style: settings.markdown, palette: look.glow, syntax: look.glowSyntax }),
    verbose: () => app.chrome.verbose,
    busy: () => app.conversation.busy,
    cwd,
    onEntries: () => app.dashboard?.sync(),
    onCopy: (text) => {
      void app.commands.copy(text).then((ok) => app.chrome.flash(ok ? "Copied reply" : "Could not reach the clipboard", ok ? "success" : "error", 1400));
    },
  });
  app.menus = new Menus(
    renderer,
    () => ({ ...look.th, bg: look.surface() }),
    (open) => {
      if (open) view.input.blur();
      else view.input.focus();
      app.chrome.drawSpinner();
      app.prompt.drawCompletions();
      app.chrome.drawStatus();
    },
    () => settings.background,
  );
  app.chrome = createChrome(app);
  app.conversation = createConversation(app);
  app.dashboard = createDashboard(app);
  app.options = createOptions(app);
  app.prompt = createPrompt(app);
  app.modes = createModes(app);
  app.commands = createCommands(app);
  view.input.focus();

  bindKeys(app);
  renderer.on("focus", () => (app.chrome.focused = true));
  renderer.on("blur", () => (app.chrome.focused = false));
  renderer.on("resize", () => app.chrome.layout());
  renderer.on("theme_mode", () => {
    if (settings.theme === "auto") app.chrome.applyTheme();
  });
  renderer.on("selection", (selection: { getSelectedText(): string }) => {
    const picked = selection.getSelectedText();
    if (picked.trim()) void app.commands.copy(picked).then((ok) => ok && app.chrome.flash("Copied selection", "success", 1200));
  });

  app.chrome.apply();
  app.conversation.reset();
  // Start indexing files for @ mentions.
  listFiles(cwd);

  const fail = (what: string, err: unknown): never => {
    renderer.destroy();
    console.error(`Failed to start ${what}:`, errorText(err));
    console.error(`Agent log: ${AGENT_LOG}`);
    app.agent?.stop();
    process.exit(1);
  };

  try {
    app.agent = await startAgent(cwd, { onUpdate: app.conversation.onUpdate, onPermission: app.conversation.onPermission });
  } catch (err) {
    fail("the agent", err);
  }
  const agent = app.agent!;
  agent.exited.then((code) => app.conversation.onAgentExit(code));

  try {
    let loaded = false;
    if (typeof opts.resume === "string") {
      await app.conversation.loadSession(opts.resume);
      loaded = true;
    } else if (opts.continueLast) {
      const last = (await agent.listSessions().catch(() => []))[0];
      if (last) {
        await app.conversation.loadSession(last.sessionId, last.title ?? "");
        loaded = true;
      } else app.chrome.flash("No earlier session to continue: starting a new one");
    }
    if (!loaded && opts.resume === true) loaded = await app.conversation.pickSession();
    if (!loaded) await agent.newSession();
  } catch (err) {
    fail("a session", err);
  }

  if (opts.model && !(await app.options.setByName("model", opts.model))) app.chrome.flash(`No model matches "${opts.model}"`, "warning");
  if (opts.mode && !(await app.options.setByName("mode", opts.mode))) app.chrome.flash(`No mode matches "${opts.mode}"`, "warning");
  app.conversation.ready();
  app.conversation.refreshSplash();
  app.chrome.layout();
  app.chrome.drawStatus();
  void app.dashboard.refresh();
  if (opts.prompt) {
    history.add(opts.prompt);
    void app.conversation.send(opts.prompt);
  }
  return app;
}
