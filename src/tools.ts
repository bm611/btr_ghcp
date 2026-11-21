import type * as acp from "@agentclientprotocol/sdk";
import { createTwoFilesPatch } from "diff";
import { isAbsolute, relative } from "node:path";

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
};

export function shortPath(cwd: string, path: string) {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  if (!rel) return ".";
  return rel.startsWith("..") ? path.replace(process.env.HOME ?? "\0", "~") : rel;
}

function field(input: unknown, ...names: string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const n of names) {
    const v = (input as Record<string, unknown>)[n];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

const oneLine = (s: string, max = 120) => {
  const flat = s.replace(/\s*\n\s*/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

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

/** The files a finished edit changed, with line counts. */
export function toolFileChanges(tool: ToolState, cwd: string): { path: string; added: number; removed: number }[] {
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

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

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTokens(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The first `max` lines of `text` and how many were left out. */
export function clipLines(text: string, max: number): { text: string; hidden: number } {
  const lines = text.split("\n");
  if (lines.length <= max) return { text, hidden: 0 };
  return { text: lines.slice(0, max).join("\n"), hidden: lines.length - max };
}
