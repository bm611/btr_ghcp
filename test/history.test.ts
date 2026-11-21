import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts reads BTR_HOME when it loads, so set it before importing.
process.env.BTR_HOME = await mkdtemp(join(tmpdir(), "btr-home-"));
const { History, loadSettings, saveSettings } = await import("../src/config");

test("history walks back and forth and keeps the draft", async () => {
  const h = await History.load("/a");
  h.add("first");
  h.add("second");
  h.add("second");
  expect(h.all()).toEqual(["second", "first"]);
  expect(h.prev("draft")).toBe("second");
  expect(h.prev("ignored")).toBe("first");
  expect(h.prev("ignored")).toBeNull();
  expect(h.next()).toBe("second");
  expect(h.next()).toBe("draft");
  expect(h.next()).toBeNull();
});

test("history persists per directory", async () => {
  const h = await History.load("/b");
  h.add("only in b");
  await Bun.sleep(50);
  expect((await History.load("/b")).all()).toEqual(["only in b"]);
  expect((await History.load("/c")).all()).toEqual([]);
});

test("settings round-trip over the defaults, and old theme names migrate", async () => {
  const defaults: Awaited<ReturnType<typeof loadSettings>> = { theme: "auto", background: false, markdown: "glow", sidebar: false, verbose: false, notifications: true };
  expect(await loadSettings()).toEqual(defaults);
  await saveSettings({ ...defaults, theme: "daylight", sidebar: true });
  expect(await loadSettings()).toEqual({ ...defaults, theme: "daylight", sidebar: true });
  await Bun.write(join(process.env.BTR_HOME!, "config.json"), JSON.stringify({ theme: "dark" }));
  expect((await loadSettings()).theme).toBe("charm");
});
