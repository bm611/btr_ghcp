import type * as acp from "@agentclientprotocol/sdk";
import { AGENT_LOG } from "../agent/connection";
import { errorText, formatDuration, shortPath, timeAgo, trunc } from "../core/format";
import { type FileChange, type ToolState, toolFileChanges } from "../core/tools";
import type { Tone } from "../ui/text";
import { G } from "../ui/theme";
import type { Entry, Item } from "../ui/transcript";
import { VERSION } from "../version";
import type { App } from "./app";
import { askPermission } from "./permission";

type EntryOf<T extends Item["type"]> = Entry<Extract<Item, { type: T }>>;

/** The turn in progress. */
type Turn = { since: number; chars: number; label: string; cancelled: boolean };

export type Conversation = ReturnType<typeof createConversation>;

/**
 * The conversation with the agent: what its session updates add to the transcript, the life
 * of a turn from the prompt to the line that closes it, the queue of messages typed meanwhile,
 * and starting, resuming and listing sessions.
 */
export function createConversation(app: App) {
  const { transcript, cwd } = app;
  let busy = false;
  /** While a session loads, the agent replays it: its messages are history, not a live turn. */
  let replaying = false;
  let disconnected = false;
  let commands: acp.AvailableCommand[] = [];
  let usage: acp.UsageUpdate | null = null;
  let sessionTitle = "";
  let plan: acp.PlanEntry[] = [];
  let turn: Turn | null = null;
  let turns = 0;
  const started = Date.now();
  const queue: string[] = [];
  /** Shell output the agent has not seen yet; it rides along with the next prompt. */
  const shellContext: string[] = [];
  /** Lines each finished edit changed, by tool call. */
  const changes = new Map<string, FileChange[]>();
  /** The blocks the agent is still adding to. */
  const cur: { reply?: EntryOf<"assistant">; thought?: EntryOf<"thought">; plan?: EntryOf<"plan">; user?: EntryOf<"user"> } = {};
  const tools = new Map<string, EntryOf<"tool">>();
  // Settles once the first session exists; prompts sent while the agent warms up wait on it.
  let markReady = () => {};
  const sessionReady = new Promise<void>((resolve) => (markReady = resolve));

  const note = (text: string, tone?: Tone) => transcript.note(text, tone);
  const setLabel = (label: string) => {
    if (turn) turn.label = label;
  };

  function endReply() {
    if (cur.reply) transcript.finishReply(cur.reply);
    cur.reply = undefined;
  }

  function endThought() {
    if (!cur.thought) return;
    cur.thought.item.ms = Date.now() - cur.thought.item.since;
    transcript.update(cur.thought);
    cur.thought = undefined;
  }

  function endBlocks() {
    endReply();
    endThought();
    cur.user = undefined;
  }

  /** The welcome line, as fx prints it: "btr v0.2.0 · / for commands". */
  const splash = (): Extract<Item, { type: "splash" }> => ({ type: "splash", name: "btr", detail: `v${VERSION} · / for commands · ? for keys` });

  function refreshSplash() {
    const first = transcript.entries[0];
    if (first?.item.type !== "splash") return;
    Object.assign(first.item, splash());
    transcript.update(first);
  }

  /** Empties the transcript for a new or resumed session. */
  function reset() {
    app.options.forgetRouted();
    transcript.clear();
    tools.clear();
    changes.clear();
    cur.reply = cur.thought = cur.plan = cur.user = undefined;
    plan = [];
    usage = null;
    sessionTitle = "";
    transcript.add(splash());
    app.chrome.layout();
    app.chrome.setTitle();
  }

  const contentText = (c: acp.ContentBlock) =>
    c.type === "text" ? c.text : c.type === "resource_link" ? `@${shortPath(cwd, c.uri.replace(/^file:\/\//, ""))} ` : c.type === "image" ? "[Image] " : "";

  function recordChanges(tool: ToolState) {
    const list = toolFileChanges(tool, cwd);
    if (!list.length) return;
    changes.set(tool.id, list);
    app.chrome.drawSidebar();
  }

  // ── session updates ─────────────────────────────────────────────────────
  function onUpdate(u: acp.SessionUpdate) {
    const { chrome } = app;
    switch (u.sessionUpdate) {
      case "user_message_chunk": {
        // Only a loaded session replays user messages.
        const t = contentText(u.content);
        if (!t) return;
        endReply();
        endThought();
        if (cur.user) {
          cur.user.item.text += t;
          transcript.update(cur.user);
        } else cur.user = transcript.add({ type: "user", text: t, mode: "prompt" });
        return;
      }
      case "agent_message_chunk": {
        const t = contentText(u.content);
        if (!t) return;
        endThought();
        cur.user = undefined;
        if (turn) turn.chars += t.length;
        setLabel("Generating");
        if (!cur.reply) cur.reply = transcript.add({ type: "assistant", text: "", streaming: !replaying });
        transcript.append(cur.reply, t);
        if (!replaying) chrome.markUnread();
        return;
      }
      case "agent_thought_chunk": {
        const t = contentText(u.content);
        if (!t) return;
        // Reply text after this thought starts a new block below it.
        endReply();
        cur.user = undefined;
        if (turn) turn.chars += t.length;
        setLabel("Thinking");
        if (!cur.thought) cur.thought = transcript.add({ type: "thought", text: "", since: Date.now(), ms: replaying ? 0 : undefined });
        transcript.appendThought(cur.thought, t);
        if (!replaying) chrome.markUnread();
        return;
      }
      case "tool_call": {
        endBlocks();
        const status = u.status ?? "pending";
        const now = Date.now();
        const tool: ToolState = {
          id: u.toolCallId,
          title: u.title,
          kind: u.kind,
          status,
          rawInput: u.rawInput,
          rawOutput: u.rawOutput,
          content: u.content ?? [],
          locations: u.locations ?? [],
          startedAt: replaying ? undefined : now,
          endedAt: !replaying && (status === "completed" || status === "failed") ? now : undefined,
        };
        setLabel("Running");
        const existing = tools.get(u.toolCallId);
        if (existing) {
          tool.startedAt ??= existing.item.tool.startedAt;
          existing.item.tool = tool;
          transcript.update(existing);
        } else tools.set(u.toolCallId, transcript.add({ type: "tool", tool }));
        recordChanges(tool);
        if (!replaying) chrome.markUnread();
        return;
      }
      case "tool_call_update": {
        const entry = tools.get(u.toolCallId);
        if (!entry) return;
        const tool = entry.item.tool;
        if (u.title) tool.title = u.title;
        if (u.kind) tool.kind = u.kind;
        if (u.status) tool.status = u.status;
        if (u.content) tool.content = u.content;
        if (u.locations) tool.locations = u.locations;
        if (u.rawInput !== undefined) tool.rawInput = u.rawInput;
        if (u.rawOutput !== undefined) tool.rawOutput = u.rawOutput;
        if (u.status === "completed" || u.status === "failed") {
          if (!replaying && tool.startedAt !== undefined && tool.endedAt === undefined) tool.endedAt = Date.now();
          setLabel("Working");
        }
        transcript.update(entry);
        recordChanges(tool);
        return;
      }
      case "plan": {
        endBlocks();
        plan = u.entries;
        // The agent resends the whole plan on every change: keep one block per turn.
        if (cur.plan) {
          cur.plan.item.entries = u.entries;
          transcript.update(cur.plan);
        } else cur.plan = transcript.add({ type: "plan", entries: u.entries });
        chrome.drawTodos();
        chrome.drawSidebar();
        return;
      }
      case "available_commands_update":
        commands = u.availableCommands;
        return;
      case "config_option_update":
        if (app.agent) app.agent.configOptions = u.configOptions;
        chrome.layout();
        return;
      case "current_mode_update": {
        const mode = app.options.option("mode");
        if (mode) mode.currentValue = u.currentModeId;
        chrome.layout();
        return;
      }
      case "session_info_update":
        if (u.title) sessionTitle = u.title;
        chrome.setTitle();
        chrome.drawSidebar();
        return;
      case "usage_update":
        usage = u;
        void app.options.refreshRouted();
        chrome.drawSidebar();
        chrome.drawStatus();
        return;
      case "notice":
        endBlocks();
        note([u.title, u.description].filter(Boolean).join(": "), u.severity === "error" ? "error" : u.severity === "warning" ? "warning" : "dim");
        return;
      case "compaction_update":
        endBlocks();
        if (u.status === "in_progress") note(`Compacting the conversation${G.ellipsis}`);
        else if (u.status === "completed") note("Conversation compacted", "success");
        else note(`Compaction ${u.status}${u.error ? `: ${u.error}` : ""}`, "warning");
        return;
    }
  }

  async function onPermission(req: acp.RequestPermissionRequest): Promise<acp.RequestPermissionOutcome> {
    setLabel("Waiting for approval");
    app.chrome.notify();
    const optionId = await askPermission(app, req, tools.get(req.toolCall.toolCallId)?.item.tool);
    setLabel("Working");
    // Dismissing the request declines it and stops the turn, as esc does anywhere else.
    if (!optionId && busy && !turn?.cancelled) interrupt();
    return optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" };
  }

  // ── turns ───────────────────────────────────────────────────────────────
  async function send(prompt: string) {
    const { agent, chrome, options } = app;
    if (disconnected) return void note("The agent is not connected.", "error");
    const desc = app.attachments.describe(prompt);
    const attached = [
      ...desc.mentions.map((m) => `@${m}`),
      ...desc.images.map((im) => `[Image #${im.id}]`),
    ];
    const asked = transcript.add({
      type: "user",
      text: prompt,
      mode: "prompt",
      ...(attached.length ? { attachments: attached } : {}),
    });
    cur.reply = cur.thought = cur.plan = cur.user = undefined;
    busy = true;
    turns++;
    const connected = !!agent?.sessionId;
    turn = { since: Date.now(), chars: 0, label: connected ? "Thinking" : "Connecting", cancelled: false };
    app.prompt.draw();
    chrome.drawStatus();
    chrome.startSpinner();
    chrome.setTitle();
    let tone: Tone = "dim";
    let outcome = "";
    try {
      if (!connected) {
        await sessionReady;
        setLabel("Thinking");
      }
      if (!app.agent) throw new Error("The agent is not connected.");
      if (turn?.cancelled) return;
      const blocks = await app.attachments.blocks(prompt, cwd, !!app.agent.capabilities.promptCapabilities?.image);
      if (shellContext.length) blocks.unshift({ type: "text", text: shellContext.splice(0).join("\n\n") });
      // Copilot logs its routing choice a moment after the prompt lands.
      const peek = setTimeout(() => void options.refreshRouted(), 800);
      const res = await app.agent.prompt(blocks).finally(() => clearTimeout(peek));
      await options.refreshRouted();
      endBlocks();
      if (res.stopReason === "cancelled") {
        outcome = "interrupted";
        tone = "warning";
      } else if (res.stopReason !== "end_turn") {
        outcome = `stopped: ${res.stopReason.replace(/_/g, " ")}`;
        tone = "warning";
      }
    } catch (err) {
      endBlocks();
      note(errorText(err), "error");
      outcome = "failed";
      tone = "error";
    } finally {
      const cancelled = turn?.cancelled;
      const ms = turn ? Date.now() - turn.since : 0;
      busy = false;
      turn = null;
      chrome.stopSpinner();
      transcript.tick();
      // Calls the agent never finished stop blinking and read as abandoned.
      for (const e of tools.values()) if (e.item.tool.status === "pending" || e.item.tool.status === "in_progress") transcript.update(e);
      if (!cancelled && !outcome) foldTurn(asked);
      const replyText = (() => {
        for (let i = transcript.entries.length - 1; i >= 0; i--) {
          const e = transcript.entries[i]!;
          if (e === asked) break;
          if (e.item.type === "assistant" && e.item.text.trim()) return e.item.text;
        }
        return undefined;
      })();
      if (cancelled) transcript.add({ type: "footer", text: `${G.stop} Cancelled · What should the agent do differently?`, tone: "text" });
      else
        transcript.add({
          type: "footer",
          text: [outcome ? `${outcome} after ${formatDuration(ms)}` : `Worked for ${formatDuration(ms)}`, options.modelLabel()].filter(Boolean).join(" · "),
          tone,
          replyText,
        });
      chrome.setTitle();
      app.prompt.draw();
      chrome.drawStatus();
      chrome.notify();
      if (queue.length) {
        const next = queue.splice(0);
        chrome.drawQueue();
        // An interrupted turn hands queued messages back for editing rather than sending them.
        if (cancelled) app.prompt.setInput([...next, app.prompt.text].filter(Boolean).join("\n"));
        else void send(next.join("\n\n"));
      }
    }
  }

  /**
   * Once a turn ends, its thinking, tool calls and in-between messages fold into one line,
   * so the reply that closes it stands on its own. Errors and warnings stay in view.
   */
  function foldTurn(asked: Entry) {
    const after = transcript.entries.slice(transcript.entries.indexOf(asked) + 1);
    let last = -1;
    for (let i = after.length - 1; i >= 0; i--) {
      const it = after[i]!.item;
      if (it.type === "assistant" && it.text.trim()) {
        last = i;
        break;
      }
    }
    if (last <= 0) return;
    const members = after.slice(0, last).filter((e) => !(e.item.type === "note" && (e.item.tone === "error" || e.item.tone === "warning")));
    if (members.some((e) => e.item.type === "tool" || e.item.type === "thought")) transcript.fold(members);
  }

  function interrupt() {
    if (!busy) return;
    if (turn) turn.cancelled = true;
    app.menus.cancelAll();
    // A prompt still waiting for the session never reached the agent; send() drops it once ready.
    if (app.agent?.sessionId) app.agent.cancel();
  }

  /** Sends `prompt`, or queues it while a turn runs. */
  function passToAgent(prompt: string) {
    if (busy) {
      queue.push(prompt);
      app.chrome.drawQueue();
    } else void send(prompt);
  }

  /** Removes and returns the queued message at `index` (defaults to the last one). */
  function popQueue(index = queue.length - 1): string | undefined {
    if (index < 0 || index >= queue.length) return undefined;
    const [removed] = queue.splice(index, 1);
    app.chrome.drawQueue();
    return removed;
  }

  function onAgentExit(code: number) {
    disconnected = true;
    busy = false;
    turn = null;
    app.chrome.stopSpinner();
    app.menus.cancelAll();
    note(`The agent exited (code ${code}). Restart btr to continue; its log is ${AGENT_LOG}`, "error");
    app.chrome.drawStatus();
  }

  // ── sessions ────────────────────────────────────────────────────────────
  async function loadSession(id: string, title = "") {
    const agent = app.agent;
    if (!agent) return;
    reset();
    replaying = true;
    try {
      await agent.loadSession(id);
      endBlocks();
      sessionTitle ||= title;
      note(`Resumed ${trunc((sessionTitle || id).split("\n")[0]!, 60)}`);
    } catch (err) {
      endBlocks();
      note(`Could not resume ${id}: ${errorText(err)}`, "error");
      if (!agent.sessionId) await agent.newSession();
    } finally {
      replaying = false;
      cur.plan = undefined;
      void app.options.refreshRouted();
      refreshSplash();
      app.chrome.layout();
      app.chrome.setTitle();
    }
  }

  async function newSession() {
    if (busy) return app.chrome.flash("Wait for the turn to end, or press esc to interrupt it", "warning");
    if (!app.agent) return;
    await app.agent.newSession();
    reset();
    refreshSplash();
    app.chrome.flash("New session", "success", 1500);
  }

  /** Shows the session list; resolves false when nothing was loaded. */
  async function pickSession(): Promise<boolean> {
    const { agent, chrome } = app;
    if (!agent) return false;
    if (busy) return (chrome.flash("Wait for the turn to end, or press esc to interrupt it", "warning"), false);
    if (!agent.capabilities.loadSession) return (chrome.flash("This agent cannot resume sessions", "warning"), false);
    const sessions = (await agent.listSessions().catch(() => [])).filter((s) => s.sessionId !== agent.sessionId);
    if (!sessions.length) return (chrome.flash("No earlier sessions for this directory"), false);
    const id = await app.menus.open({
      title: "Sessions",
      options: sessions.map((s) => ({ label: (s.title ?? s.sessionId).split("\n")[0]!.slice(0, 80), value: s.sessionId, hint: timeAgo(s.updatedAt) })),
      filterable: true,
      placeholder: "Search sessions",
      width: 90,
    });
    if (!id) return false;
    await loadSession(id, sessions.find((s) => s.sessionId === id)?.title ?? "");
    return true;
  }

  return {
    onUpdate,
    onPermission,
    onAgentExit,
    /** Lets prompts sent during startup through, once the first session exists. */
    ready: () => markReady(),
    send,
    passToAgent,
    popQueue,
    interrupt,
    reset,
    refreshSplash,
    loadSession,
    newSession,
    pickSession,
    shellContext,
    started,
    /** Whether the agent offers a slash command of this name. */
    agentHas: (name: string) => commands.some((c) => c.name === name),
    contextPct: () => (usage?.size ? Math.round((usage.used / usage.size) * 100) : null),
    get busy() {
      return busy;
    },
    get disconnected() {
      return disconnected;
    },
    get turn(): Readonly<Turn> | null {
      return turn;
    },
    get turns() {
      return turns;
    },
    get commands(): readonly acp.AvailableCommand[] {
      return commands;
    },
    get usage() {
      return usage;
    },
    get plan() {
      return plan;
    },
    get sessionTitle() {
      return sessionTitle;
    },
    get changes(): ReadonlyMap<string, FileChange[]> {
      return changes;
    },
    get queue(): readonly string[] {
      return queue;
    },
  };
}
