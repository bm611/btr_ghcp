#!/usr/bin/env bun
/**
 * A scripted ACP agent for trying the interface without Copilot:
 *
 *   BTR_AGENT="bun test/fake-agent.ts" bun start
 *
 * Every prompt gets the same turn: thinking, a plan, a read, a shell command that
 * asks for permission, an edit with a diff that asks for permission, and a Markdown reply.
 * A prompt containing "quick" gets a one-line reply; "slow" keeps working until cancelled.
 */
const MODES = ["agent", "plan", "autopilot"].map((m) => ({ value: `mode#${m}`, name: m[0]!.toUpperCase() + m.slice(1), description: `${m} mode` }));
const MODELS = ["Auto", "Sonnet 5", "GPT-6", "Gemini 4 Pro"].map((n) => ({ value: n.toLowerCase().replace(/ /g, "-"), name: n, description: `${n} model` }));
let mode = MODES[0]!.value;
let model = MODELS[0]!.value;
let allowAll = "off";
let nextId = 1000;
let cancelled = false;
let used = 9000;
const waiting = new Map<number, (result: any) => void>();

const write = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const update = (sessionId: string, u: unknown) => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const request = (method: string, params: unknown) =>
  new Promise<any>((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    write({ jsonrpc: "2.0", id, method, params });
  });

const configOptions = () => [
  { type: "select", id: "mode", name: "Mode", category: "mode", description: "How the agent responds.", currentValue: mode, options: MODES },
  { type: "select", id: "model", name: "Model", category: "model", description: "The model that answers.", currentValue: model, options: MODELS },
  {
    type: "select",
    id: "allow_all",
    name: "Allow All",
    category: "permissions",
    description: "Approve every tool call without asking.",
    currentValue: allowAll,
    options: [
      { value: "on", name: "On", description: "Approve everything" },
      { value: "off", name: "Off", description: "Ask first" },
    ],
  },
];

const COMMANDS = [
  { name: "compact", description: "Summarize the conversation to free up context.", input: { hint: "focus" } },
  { name: "context", description: "Show context window usage." },
  { name: "init", description: "Create an instructions file for this project." },
  { name: "review", description: "Review the uncommitted changes.", input: { hint: "instructions" } },
  { name: "usage", description: "Show usage for this session." },
];

async function say(sid: string, kind: "agent_message_chunk" | "agent_thought_chunk", text: string, delay = 12) {
  for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
    if (cancelled) return;
    update(sid, { sessionUpdate: kind, content: { type: "text", text: piece } });
    await sleep(delay);
  }
}

async function ask(sid: string, toolCall: unknown) {
  if (allowAll === "on") return true;
  const res = await request("session/request_permission", {
    sessionId: sid,
    toolCall,
    options: [
      { optionId: "once", name: "Yes", kind: "allow_once" },
      { optionId: "always", name: "Yes, and don't ask again this session", kind: "allow_always" },
      { optionId: "no", name: "No, and tell the agent what to do differently", kind: "reject_once" },
    ],
  });
  return res?.outcome?.outcome === "selected" && res.outcome.optionId !== "no";
}

async function turn(sid: string, prompt: string): Promise<string> {
  cancelled = false;
  const stop = () => (cancelled ? "cancelled" : null);
  if (/quick/.test(prompt)) {
    await say(sid, "agent_message_chunk", "Done. That was the quick one.");
    return stop() ?? "end_turn";
  }
  if (/slow/.test(prompt)) {
    update(sid, { sessionUpdate: "tool_call", toolCallId: "slow", title: "Wait for a long build", kind: "execute", status: "in_progress", rawInput: { command: "sleep 600" } });
    while (!cancelled) await sleep(100);
    return "cancelled";
  }

  await say(sid, "agent_thought_chunk", "The user wants a demonstration. I should read the manifest, list the files, then make a small edit and explain it.", 20);
  if (stop()) return "cancelled";

  const plan = (...status: string[]) =>
    update(sid, {
      sessionUpdate: "plan",
      entries: ["Read package.json", "List the source files", "Update the greeting"].map((content, i) => ({ content, priority: "medium", status: status[i] })),
    });
  plan("in_progress", "pending", "pending");

  await say(sid, "agent_message_chunk", "I'll start by looking at the project manifest.");
  update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Viewing package.json", kind: "read", status: "pending", rawInput: { path: `${process.cwd()}/package.json` }, locations: [{ path: `${process.cwd()}/package.json` }] });
  await sleep(500);
  const manifest = await Bun.file("package.json").text().catch(() => '{\n  "name": "demo"\n}');
  update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: { content: manifest } });
  plan("completed", "in_progress", "pending");
  if (stop()) return "cancelled";

  const lsCall = { toolCallId: "t2", title: "List the source files", kind: "execute", status: "pending", rawInput: { command: "ls -la src", description: "List the source files" } };
  update(sid, { sessionUpdate: "tool_call", ...lsCall });
  if (await ask(sid, lsCall)) {
    update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "in_progress" });
    await sleep(400);
    const out = Array.from({ length: 9 }, (_, i) => `-rw-r--r--  1 dev  staff  ${1200 + i * 317} Nov 15 10:0${i} file${i}.ts`).join("\n");
    update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed", content: [{ type: "content", content: { type: "text", text: `total 72\n${out}` } }] });
  } else {
    update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "failed", content: [{ type: "content", content: { type: "text", text: "The user declined this command." } }] });
  }
  plan("completed", "completed", "in_progress");
  if (stop()) return "cancelled";

  const oldText = 'export function greet(name: string) {\n  return "Hello " + name;\n}\n\nexport const DEFAULT = "world";\n';
  const newText = 'export function greet(name: string, excited = false) {\n  const mark = excited ? "!" : ".";\n  return `Hello, ${name}${mark}`;\n}\n\nexport const DEFAULT = "world";\n';
  const editCall = { toolCallId: "t3", title: "Editing src/greet.ts", kind: "edit", status: "pending", locations: [{ path: `${process.cwd()}/src/greet.ts` }], content: [{ type: "diff", path: `${process.cwd()}/src/greet.ts`, oldText, newText }] };
  update(sid, { sessionUpdate: "tool_call", ...editCall });
  const edited = await ask(sid, editCall);
  update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t3", status: edited ? "completed" : "failed", ...(edited ? {} : { content: [{ type: "content", content: { type: "text", text: "The user declined this edit." } }] }) });
  plan("completed", "completed", "completed");
  if (stop()) return "cancelled";

  used += 6400;
  update(sid, { sessionUpdate: "usage_update", used, size: 128000 });
  await say(
    sid,
    "agent_message_chunk",
    [
      "# Demo complete\n\n",
      "## Summary\n\n",
      "I read the manifest, listed the sources, and updated **`greet`** so it can sound excited.\n\n",
      "- `greet(name)` still works as before\n",
      "- `greet(name, true)` ends with an exclamation mark\n\n",
      "```ts\nimport { greet } from \"./greet\";\n\nconsole.log(greet(\"world\", true)); // Hello, world!\n```\n\n",
      "| File | Change |\n| --- | --- |\n| `src/greet.ts` | new `excited` flag |\n\n",
      "### Next steps\n\n",
      "> Tests are not run yet.\n\n",
      "1. Run `bun test`\n2. Read [the docs](https://example.com/docs)\n\n",
      "---\n\n",
      "_That's all._",
    ].join(""),
  );
  return stop() ?? "end_turn";
}

const sessions = [
  { sessionId: "sess-earlier-0001", cwd: process.cwd(), title: "Fix the flaky login test", updatedAt: new Date(Date.now() - 3600e3).toISOString() },
  { sessionId: "sess-earlier-0002", cwd: process.cwd(), title: "Explain the build pipeline", updatedAt: new Date(Date.now() - 86400e3 * 2).toISOString() },
];

async function handle(m: any) {
  const reply = (result: unknown) => write({ jsonrpc: "2.0", id: m.id, result });
  const session = (sid: string) => {
    update(sid, { sessionUpdate: "available_commands_update", availableCommands: COMMANDS });
    return { sessionId: sid, configOptions: configOptions() };
  };
  switch (m.method) {
    case "initialize":
      return reply({
        protocolVersion: 1,
        agentInfo: { name: "Fake", title: "Fake Agent", version: "0.0.1" },
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { list: {} } },
        authMethods: [],
      });
    case "session/new":
      return reply(session(`sess-${Date.now()}`));
    case "session/list":
      return reply({ sessions });
    case "session/load": {
      const sid = m.params.sessionId;
      update(sid, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Why is the login test flaky?" } });
      update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Probably a race between the mock server and the first request." } });
      update(sid, { sessionUpdate: "tool_call", toolCallId: "old1", title: "Viewing test/login.test.ts", kind: "read", status: "pending", rawInput: { path: `${process.cwd()}/test/login.test.ts` } });
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: "old1", status: "completed", rawOutput: { content: "line one\nline two\nline three" } });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The test starts its request before the mock server is listening. Await `server.ready` first." } });
      return reply(session(sid));
    }
    case "session/set_config_option":
      if (m.params.configId === "mode") mode = m.params.value;
      if (m.params.configId === "model") model = m.params.value;
      if (m.params.configId === "allow_all") allowAll = m.params.value;
      return reply({ configOptions: configOptions() });
    case "session/prompt": {
      const prompt = m.params.prompt.map((b: any) => (b.type === "text" ? b.text : `[${b.type}${b.name ? ":" + b.name : ""}]`)).join(" ");
      if (/echo/.test(prompt)) {
        update(m.params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "You sent: " + prompt } });
        return reply({ stopReason: "end_turn" });
      }
      return reply({ stopReason: await turn(m.params.sessionId, prompt) });
    }
    case "session/cancel":
      cancelled = true;
      // A cancelled turn answers its open permission requests as cancelled.
      for (const [id, resolve] of waiting) {
        waiting.delete(id);
        resolve({ outcome: { outcome: "cancelled" } });
      }
      return;
    default:
      if (m.id !== undefined && m.method) write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no ${m.method}` } });
  }
}

let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method) void handle(m);
    else if (waiting.has(m.id)) {
      const resolve = waiting.get(m.id)!;
      waiting.delete(m.id);
      resolve(m.result);
    }
  }
}
