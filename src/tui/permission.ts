import type * as acp from "@agentclientprotocol/sdk";
import { BoxRenderable, type Renderable, type TextChunk, TextRenderable, fg } from "@opentui/core";
import { tildify } from "../core/format";
import { toolHeader, toolPatches, type ToolState } from "../core/tools";
import { styled } from "../ui/text";
import { toolVerb } from "../ui/transcript";
import type { App } from "./app";

/** The letter that picks each kind of option, and its name in the line of keys. */
const OPTION_KEYS: Record<string, [string, string]> = {
  allow_once: ["a", "allow"],
  allow_always: ["s", "allow for session"],
  reject_once: ["d", "deny"],
  reject_always: ["f", "always deny"],
};

/**
 * Asks whether a tool call may run, in the panel that rises from the bottom: what the tool
 * wants and why, then the command or the diff, then the agent's options. `known` is what the
 * transcript already has of the call. Resolves with the chosen option's id, or null when dismissed.
 */
export function askPermission(app: App, req: acp.RequestPermissionRequest, known?: ToolState): Promise<string | null> {
  const { cwd, renderer } = app;
  const tool: ToolState = {
    id: req.toolCall.toolCallId,
    title: req.toolCall.title ?? known?.title ?? "Tool call",
    kind: req.toolCall.kind ?? known?.kind,
    status: "pending",
    rawInput: req.toolCall.rawInput ?? known?.rawInput,
    content: req.toolCall.content ?? known?.content ?? [],
    locations: req.toolCall.locations ?? known?.locations ?? [],
  };
  const { name, arg } = toolHeader(tool, cwd);
  const patches = toolPatches(tool, cwd);
  const used = new Set<string>();
  return app.menus.open({
    title: "Permission needed",
    buttons: true,
    body: () => {
      const th = app.look.th;
      const nodes: Renderable[] = [];
      const line = (...parts: (TextChunk | string)[]) => new TextRenderable(renderer, { content: styled(...parts), flexShrink: 0, wrapMode: "word" });
      const reason = tool.title && tool.title !== arg && !tool.title.endsWith(arg) ? tool.title : "";
      if (tool.kind === "execute") {
        nodes.push(line(fg(th.fg)(`Run a command in ${tildify(cwd)}`), reason ? fg(th.fgMuted)(` · ${reason}`) : ""));
        const cmd = new BoxRenderable(renderer, { flexShrink: 0, marginTop: 1, border: ["left"], borderStyle: "single", borderColor: th.separatorSubtle, paddingLeft: 1 });
        cmd.add(new TextRenderable(renderer, { content: styled(fg(th.fgMuted)("$ "), fg(th.fg)(arg)), flexShrink: 1 }));
        nodes.push(cmd);
      } else {
        nodes.push(line(fg(th.fg)(toolVerb(name, "pending")), arg ? fg(th.fgSubtle)(" " + arg) : "", reason ? fg(th.fgMuted)(` · ${reason}`) : ""));
        for (const p of patches) {
          const d = app.transcript.diffView(p);
          d.marginTop = 1;
          nodes.push(d);
        }
      }
      return nodes;
    },
    options: req.options.map((o) => {
      const keys = OPTION_KEYS[o.kind];
      const key = keys && !used.has(keys[0]) ? keys[0] : undefined;
      if (key) used.add(key);
      return { label: o.name, value: o.optionId, key, short: keys?.[1] };
    }),
  });
}
