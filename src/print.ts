import { AGENT_LOG, choices, selectOption, startAgent } from "./agent";

export type PrintOptions = {
  cwd: string;
  prompt: string;
  /** Approve every permission request instead of declining them. */
  allowAll: boolean;
  resume?: string;
  continueLast?: boolean;
  model?: string;
  mode?: string;
};

/** Sends one prompt, writes the reply to stdout and returns the exit code. No interface. */
export async function runPrint(opts: PrintOptions): Promise<number> {
  let replaying = false;
  let wrote = false;
  let gap = false;
  const agent = await startAgent(opts.cwd, {
    onUpdate(u) {
      if (replaying) return;
      // Text on either side of a tool call is a separate paragraph.
      if (u.sessionUpdate === "tool_call") gap = wrote;
      if (u.sessionUpdate !== "agent_message_chunk" || u.content.type !== "text") return;
      process.stdout.write((gap ? "\n\n" : "") + u.content.text);
      gap = false;
      wrote = true;
    },
    async onPermission(req) {
      const want = opts.allowAll ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
      const option = req.options.find((o) => want.includes(o.kind));
      if (!opts.allowAll) console.error(`btr: declined "${req.toolCall.title ?? "tool call"}" (pass --allow-all to approve tool calls)`);
      return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
    },
  }).catch((err) => {
    console.error("btr: failed to start the agent:", err?.message ?? err, `\nAgent log: ${AGENT_LOG}`);
    return null;
  });
  if (!agent) return 1;

  try {
    const id = opts.resume ?? (opts.continueLast ? (await agent.listSessions())[0]?.sessionId : undefined);
    if (id) {
      replaying = true;
      await agent.loadSession(id);
      replaying = false;
    } else await agent.newSession();

    for (const [category, wanted] of [["model", opts.model], ["mode", opts.mode]] as const) {
      if (!wanted) continue;
      const o = selectOption(agent.configOptions, category);
      const w = wanted.toLowerCase();
      const match = o && choices(o).find((c) => c.value.toLowerCase() === w || c.name.toLowerCase() === w || c.name.toLowerCase().startsWith(w));
      if (!o || !match) console.error(`btr: no ${category} matches "${wanted}"`);
      else await agent.setConfigOption(o.id, match.value);
    }

    const res = await agent.prompt([{ type: "text", text: opts.prompt }]);
    if (wrote) process.stdout.write("\n");
    if (res.stopReason !== "end_turn") {
      console.error(`btr: stopped: ${res.stopReason}`);
      return 1;
    }
    return 0;
  } catch (err: any) {
    console.error("btr:", err?.message ?? err);
    return 1;
  } finally {
    agent.stop();
  }
}
