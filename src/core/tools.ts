import type * as acp from "@agentclientprotocol/sdk";
import { createTwoFilesPatch } from "diff";
import { formatBytes, oneLine, plural, shortPath } from "./format";

/** What the transcript keeps of a tool call. */
export type ToolState = {
  id: string;
  title: string;
  kind?: acp.ToolKind | null;
  status: acp.ToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  content: acp.ToolCallContent[];
  locations: acp.ToolCallLocation[];
  /** Timestamps (epoch ms) for elapsed duration display. */
  startedAt?: number;
  endedAt?: number;
};

function field(input: unknown, ...names: string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const n of names) {
    const v = (input as Record<string, unknown>)[n];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/** The header of a tool call: a verb such as `Read` and what it acts on. */
export function toolHeader(tool: ToolState, cwd: string): { name: string; arg: string } {
  const input = tool.rawInput;
  const diff = tool.content.find((c) => c.type === "diff");
  const path = field(input, "path", "file_path", "filePath", "file") ?? tool.locations[0]?.path ?? (diff?.type === "diff" ? diff.path : undefined);
  const command = field(input, "command", "cmd");
  const pattern = field(input, "pattern", "query", "regex");
  const url = field(input, "url");
  switch (tool.kind) {
    case "execute":
      return { name: "Bash", arg: oneLine(command ?? tool.title, 160) };
    case "read":
      if (pattern) return { name: "Search", arg: oneLine(pattern) };
      if (path) return { name: "Read", arg: shortPath(cwd, path) };
      break;
    case "search":
      return { name: "Search", arg: oneLine(pattern ?? tool.title) };
    case "edit":
      if (path) return { name: field(input, "oldText", "old_str", "diff") || hasOldText(tool) ? "Update" : "Write", arg: shortPath(cwd, path) };
      break;
    case "delete":
      if (path) return { name: "Delete", arg: shortPath(cwd, path) };
      break;
    case "move":
      if (path) return { name: "Move", arg: shortPath(cwd, path) };
      break;
    case "fetch":
      return { name: "Fetch", arg: oneLine(url ?? tool.title) };
    case "think":
      return { name: "Think", arg: "" };
  }
  return { name: oneLine(tool.title || "Tool"), arg: "" };
}

function hasOldText(tool: ToolState) {
  return tool.content.some((c) => c.type === "diff" && c.oldText);
}

/** The text a tool call produced, from ACP content or, failing that, the agent's raw output. */
export function toolOutput(tool: ToolState): string {
  const parts: string[] = [];
  for (const c of tool.content) {
    if (c.type === "content" && c.content.type === "text") parts.push(c.content.text);
  }
  if (!parts.length) {
    const raw = tool.rawOutput;
    if (typeof raw === "string") parts.push(raw);
    else {
      const text = field(raw, "content", "output", "stdout", "text", "message", "error");
      if (text) parts.push(text);
    }
  }
  return parts.join("\n").replace(/\s+$/, "");
}

/** Unified patches for a tool call: ACP `diff` content, else Copilot's `rawInput.diff`. */
export function toolPatches(tool: { content?: acp.ToolCallContent[] | null; rawInput?: unknown }, cwd: string): string[] {
  const diffs = (tool.content ?? []).filter((c) => c.type === "diff");
  if (diffs.length) {
    return diffs.map((d) => {
      const path = shortPath(cwd, d.path);
      return createTwoFilesPatch(path, path, d.oldText ?? "", d.newText, "", "", { context: 3 });
    });
  }
  const raw = (tool.rawInput as { diff?: unknown } | undefined)?.diff;
  return typeof raw === "string" && raw.trim() ? [raw.replace(/^\n+/, "")] : [];
}

export type FileChange = { path: string; added: number; removed: number };

/** The files a finished edit changed, with line counts. */
export function toolFileChanges(tool: ToolState, cwd: string): FileChange[] {
  if (tool.status !== "completed") return [];
  return toolPatches(tool, cwd).map((p) => ({
    path: /^\+\+\+ (?:b\/)?(.+?)\s*$/m.exec(p)?.[1] ?? toolHeader(tool, cwd).arg,
    ...patchStats(p),
  }));
}

export function patchStats(patch: string) {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

/** One line that sums up a finished tool call, such as "Read 120 lines". Empty when the output itself is the summary. */
export function toolSummary(tool: ToolState, cwd: string): string {
  const { name, arg } = toolHeader(tool, cwd);
  const patches = toolPatches(tool, cwd);
  if (patches.length) {
    const { added, removed } = patches.map(patchStats).reduce((a, b) => ({ added: a.added + b.added, removed: a.removed + b.removed }));
    const parts = [added && plural(added, "addition"), removed && plural(removed, "removal")].filter(Boolean);
    return `${name === "Write" ? "Wrote" : "Updated"} ${arg || "file"}${parts.length ? ` with ${parts.join(" and ")}` : ""}`;
  }
  if (tool.status !== "completed") return "";
  const out = toolOutput(tool);
  const lines = out ? out.split("\n").length : 0;
  if (name === "Read") return `Read ${plural(lines, "line")}`;
  if (name === "Search") return lines ? `Found ${plural(lines, "line")}` : "No matches";
  if (name === "Fetch") return `Received ${formatBytes(out.length)}`;
  if (!out) return "Done";
  return "";
}

/** Compact metrics for a tool call header (diff lines, output lines/bytes, duration). */
export function toolMetrics(tool: ToolState, cwd: string): { added: number; removed: number; lines: number; bytes: number; ms?: number } {
  const patches = toolPatches(tool, cwd);
  const { added, removed } = patches.length
    ? patches.map(patchStats).reduce((a, b) => ({ added: a.added + b.added, removed: a.removed + b.removed }))
    : { added: 0, removed: 0 };
  const out = toolOutput(tool);
  const lines = out ? out.split("\n").length : 0;
  const ms = tool.startedAt !== undefined && tool.endedAt !== undefined ? Math.max(0, tool.endedAt - tool.startedAt) : undefined;
  return { added, removed, lines, bytes: out.length, ms };
}
