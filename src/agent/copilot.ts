/** Things only GitHub Copilot's agent provides, read from the files it keeps. */

/** Where Copilot keeps its settings, instructions and session logs. */
export const COPILOT_HOME = process.env.COPILOT_HOME ?? `${process.env.HOME}/.copilot`;

/**
 * The display name of the model Copilot's "auto" routing picked for this session's latest
 * turn. ACP only ever reports "auto", so this reads the event log Copilot keeps for each
 * session; null when there is none (another agent, or no turn routed yet). Only the log's
 * tail is read.
 */
export async function routedModel(sessionId: string): Promise<string | null> {
  if (!sessionId || /[^\w-]/.test(sessionId)) return null;
  const file = Bun.file(`${COPILOT_HOME}/session-state/${sessionId}/events.jsonl`);
  const text = await file
    .slice(Math.max(0, file.size - 512 * 1024))
    .text()
    .catch(() => "");
  let id = "";
  const names = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.includes('"session.auto_mode_resolved"') && !line.includes('"session.usage_record"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "session.auto_mode_resolved" && e.data?.chosenModel) id = e.data.chosenModel;
      else if (e.data?.usage?.model && e.data.usage.modelDisplayName) names.set(e.data.usage.model, e.data.usage.modelDisplayName);
    } catch {
      // The first line of the tail is usually cut in half.
    }
  }
  return id ? (names.get(id) ?? id.replace(/-/g, " ")) : null;
}
