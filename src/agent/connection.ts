import * as acp from "@agentclientprotocol/sdk";
import { VERSION } from "../version";

/** What the client does with what the agent sends it. */
export type AgentHandlers = {
  onUpdate: (update: acp.SessionUpdate) => void;
  onPermission: (req: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionOutcome>;
};

/** The agent's stderr goes here: anything it printed to the terminal would corrupt the interface. */
export const AGENT_LOG = `${process.env.TMPDIR ?? "/tmp"}/btr_ghcp-agent.log`;

export type Agent = Awaited<ReturnType<typeof startAgent>>;

/**
 * Spawns `copilot --acp` (or `$BTR_AGENT`) and speaks ACP to it over stdio.
 * `--model auto` selects Copilot Fusion, which routes to a model your plan includes;
 * without it Copilot uses the `model` from ~/.copilot/settings.json.
 *
 * The connection starts without a session: call `newSession` or `loadSession` next.
 */
export async function startAgent(cwd: string, handlers: AgentHandlers) {
  const command = (process.env.BTR_AGENT ?? "copilot --acp --model auto").split(" ").filter(Boolean);
  const proc = Bun.spawn(command, {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    // Anything the agent prints to stderr would corrupt the TUI.
    stderr: Bun.file(AGENT_LOG),
  });

  const toAgent = new WritableStream<Uint8Array>({
    write(chunk) {
      proc.stdin.write(chunk);
      proc.stdin.flush();
    },
    close() {
      proc.stdin.end();
    },
  });

  let sessionId = "";
  // While a session is being created its id is unknown, and the agent already sends updates for it.
  let opening = false;
  let configOptions: acp.SessionConfigOption[] = [];

  const app = acp
    .client({ name: "btr_ghcp" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      if (opening || params.sessionId === sessionId) handlers.onUpdate(params.update);
    })
    .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => ({
      outcome: await handlers.onPermission(params),
    }));

  const conn = app.connect(acp.ndJsonStream(toAgent, proc.stdout));
  const agent = conn.agent;

  // Resolves with the exit code when the agent process ends. Requests that are
  // in flight at that point would otherwise never settle, so race them against it.
  let stopping = false;
  const exited = proc.exited;
  const agentGone = exited.then((code) => {
    throw new Error(`agent exited (code ${code}); see ${AGENT_LOG}`);
  });
  agentGone.catch(() => {});
  const untilExit = <T>(p: Promise<T>) => Promise.race([p, agentGone]);

  const init = await untilExit(
    agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "btr_ghcp", version: VERSION },
    }),
  );
  const capabilities = init.agentCapabilities ?? {};

  return {
    info: init.agentInfo,
    capabilities,
    authMethods: init.authMethods ?? [],
    command: command.join(" "),
    get sessionId() {
      return sessionId;
    },
    get configOptions() {
      return configOptions;
    },
    set configOptions(value: acp.SessionConfigOption[]) {
      configOptions = value;
    },

    async newSession() {
      opening = true;
      try {
        const session = await untilExit(agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] }));
        sessionId = session.sessionId;
        configOptions = session.configOptions ?? [];
      } finally {
        opening = false;
      }
    },

    /** Loads an earlier session; the agent replays its history through `onUpdate` before this resolves. */
    async loadSession(id: string) {
      if (!capabilities.loadSession) throw new Error("this agent cannot load sessions");
      const previous = sessionId;
      sessionId = id;
      try {
        const session = await untilExit(agent.request(acp.methods.agent.session.load, { cwd, sessionId: id, mcpServers: [] }));
        configOptions = session?.configOptions ?? configOptions;
      } catch (err) {
        sessionId = previous;
        throw err;
      }
    },

    /** Earlier sessions for this directory, newest first; empty when the agent cannot list them. */
    async listSessions(): Promise<acp.SessionInfo[]> {
      if (!capabilities.sessionCapabilities?.list) return [];
      const all: acp.SessionInfo[] = [];
      let cursor: string | null | undefined;
      do {
        const page = await untilExit(agent.request(acp.methods.agent.session.list, { cwd, cursor }));
        all.push(...page.sessions);
        cursor = page.nextCursor;
      } while (cursor && all.length < 200);
      return all.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    },

    async setConfigOption(configId: string, value: string) {
      const res = await untilExit(agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value }));
      configOptions = res.configOptions;
      return configOptions;
    },

    /** Resolves with the exit code if the agent dies on its own (not via stop()). */
    exited: exited.then((code) => (stopping ? new Promise<number>(() => {}) : code)),

    prompt: (prompt: acp.ContentBlock[]) => untilExit(agent.request(acp.methods.agent.session.prompt, { sessionId, prompt })),

    cancel: () => agent.notify(acp.methods.agent.session.cancel, { sessionId }),

    stop: () => {
      stopping = true;
      conn.close();
      proc.kill();
    },
  };
}
