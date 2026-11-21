import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Attachments, mentionAt } from "../src/core/attachments";
import { clipLines, formatDuration, formatTokens, oneLine, shortPath, timeAgo, trunc, truncStart } from "../src/core/format";
import { fuzzyFilter, fuzzyScore } from "../src/core/fuzzy";
import { patchStats, toolFileChanges, toolHeader, toolOutput, toolPatches, toolSummary, type ToolState } from "../src/core/tools";

const tool = (over: Partial<ToolState>): ToolState => ({ id: "t", title: "Tool", status: "completed", content: [], locations: [], ...over });
const cwd = "/work/project";

test("tool headers name the action and its target", () => {
  expect(toolHeader(tool({ kind: "read", title: "Viewing x", rawInput: { path: "/work/project/src/a.ts" } }), cwd)).toEqual({ name: "Read", arg: "src/a.ts" });
  expect(toolHeader(tool({ kind: "read", rawInput: { pattern: "foo|bar", paths: [cwd] } }), cwd)).toEqual({ name: "Search", arg: "foo|bar" });
  expect(toolHeader(tool({ kind: "execute", title: "List files", rawInput: { command: "ls\n  -la" } }), cwd)).toEqual({ name: "Bash", arg: "ls -la" });
  expect(toolHeader(tool({ kind: "edit", locations: [{ path: "/work/project/new.ts" }] }), cwd)).toEqual({ name: "Write", arg: "new.ts" });
  expect(toolHeader(tool({ kind: "other", title: "Ask the duck" }), cwd)).toEqual({ name: "Ask the duck", arg: "" });
});

test("paths shorten relative to the working directory", () => {
  expect(shortPath(cwd, "/work/project")).toBe(".");
  expect(shortPath(cwd, "/work/project/a/b.ts")).toBe("a/b.ts");
  expect(shortPath(cwd, "/elsewhere/b.ts")).toBe("/elsewhere/b.ts");
  expect(shortPath(cwd, "relative.ts")).toBe("relative.ts");
});

test("tool output comes from content, then from raw output", () => {
  expect(toolOutput(tool({ content: [{ type: "content", content: { type: "text", text: "hello\n" } }] }))).toBe("hello");
  expect(toolOutput(tool({ rawOutput: { content: "from raw" } }))).toBe("from raw");
  expect(toolOutput(tool({}))).toBe("");
});

test("edits summarize their diff", () => {
  const edit = tool({ kind: "edit", content: [{ type: "diff", path: "/work/project/a.ts", oldText: "one\ntwo\n", newText: "one\n2\nthree\n" }] });
  const [patch] = toolPatches(edit, cwd);
  expect(patchStats(patch!)).toEqual({ added: 2, removed: 1 });
  expect(toolHeader(edit, cwd)).toEqual({ name: "Update", arg: "a.ts" });
  expect(toolSummary(edit, cwd)).toBe("Updated a.ts with 2 additions and 1 removal");
  expect(toolPatches({ rawInput: { diff: "\n--- a\n+++ b\n" } }, cwd)).toEqual(["--- a\n+++ b\n"]);
});

test("reads and searches summarize by line count", () => {
  expect(toolSummary(tool({ kind: "read", rawInput: { path: "/work/project/a" }, rawOutput: { content: "1\n2\n3" } }), cwd)).toBe("Read 3 lines");
  expect(toolSummary(tool({ kind: "search", rawInput: { pattern: "x" } }), cwd)).toBe("No matches");
  expect(toolSummary(tool({ kind: "execute", rawInput: { command: "ls" }, rawOutput: "a\nb" }), cwd)).toBe("");
  expect(toolSummary(tool({ kind: "read", status: "in_progress", rawInput: { path: "/work/project/a" } }), cwd)).toBe("");
});

test("formatting helpers", () => {
  expect(formatTokens(950)).toBe("950");
  expect(formatTokens(1200)).toBe("1.2k");
  expect(formatTokens(2_000_000)).toBe("2M");
  expect(formatDuration(59_000)).toBe("59s");
  expect(formatDuration(125_000)).toBe("2m 5s");
  expect(clipLines("a\nb\nc\nd", 2)).toEqual({ text: "a\nb", hidden: 2 });
  expect(clipLines("a", 2)).toEqual({ text: "a", hidden: 0 });
  expect(trunc("abcdef", 4)).toBe("abc…");
  expect(truncStart("src/deep/file.ts", 8)).toBe("…file.ts");
  expect(oneLine("a\n   b  ", 10)).toBe("a b");
  const now = Date.parse("2026-01-02T00:00:00Z");
  expect(timeAgo("2026-01-01T23:59:30Z", now)).toBe("just now");
  expect(timeAgo("2026-01-01T21:00:00Z", now)).toBe("3h ago");
  expect(timeAgo(null, now)).toBe("");
});

test("fuzzy matching prefers file names and rejects non-matches", () => {
  expect(fuzzyScore("xyz", "src/main.ts")).toBe(-1);
  const files = ["src/domain/main.ts", "src/main.ts", "README.md", "test/mainframe.test.ts"];
  expect(fuzzyFilter("main", files, (f) => f, 2)[0]).toBe("src/main.ts");
  expect(fuzzyFilter("rdm", files, (f) => f, 5)[0]).toBe("README.md");
  expect(fuzzyFilter("", files, (f) => f, 2)).toEqual(files.slice(0, 2));
});

test("mentions are found at the cursor", () => {
  expect(mentionAt("look at @src/ma", 15)).toEqual({ start: 8, query: "src/ma" });
  expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
  expect(mentionAt("mail me@example.com", 19)).toBeNull();
  expect(mentionAt("@done and more", 14)).toBeNull();
});

test("long pastes fold into placeholders and expand in the prompt", async () => {
  const a = new Attachments();
  expect(a.paste("short")).toBe("short");
  const long = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
  const placeholder = a.paste(long);
  expect(placeholder).toBe("[Pasted text #1 +8 lines]");
  const blocks = await a.blocks(`see ${placeholder} thanks`, cwd, true);
  expect(blocks).toEqual([{ type: "text", text: `see ${long} thanks` }]);
});

test("mentioned files and pasted images are attached", async () => {
  const dir = await mkdtemp(join(tmpdir(), "btr-test-"));
  await Bun.write(join(dir, "notes.md"), "hello");
  const a = new Attachments();
  const image = a.image(new Uint8Array([1, 2, 3]), "image/png");
  const blocks = await a.blocks(`read @notes.md and @missing.md ${image}`, dir, true);
  expect(blocks.map((b) => b.type)).toEqual(["text", "resource_link", "image"]);
  expect(blocks[1]).toMatchObject({ name: "notes.md", size: 5 });
  expect(blocks[2]).toMatchObject({ mimeType: "image/png", data: "AQID" });
  // An agent without image support gets the text only.
  expect((await a.blocks(image, dir, false)).map((b) => b.type)).toEqual(["text"]);
});

test("finished edits report the files they changed", () => {
  const edit = tool({ kind: "edit", content: [{ type: "diff", path: "/work/project/a.ts", oldText: "x\n", newText: "y\nz\n" }] });
  expect(toolFileChanges(edit, cwd)).toEqual([{ path: "a.ts", added: 2, removed: 1 }]);
  expect(toolFileChanges({ ...edit, status: "pending" }, cwd)).toEqual([]);
});
