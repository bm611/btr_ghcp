/**
 * Drives the whole interface against the scripted agent in test/fixtures/fake-agent.ts,
 * in a headless renderer, and checks what reaches the screen.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import type { App } from "../src/tui/app";

const TIMEOUT = 20_000;
let setup: Awaited<ReturnType<typeof createTestRenderer>>;
let app: App;

beforeAll(async () => {
  process.env.BTR_HOME = await mkdtemp(join(tmpdir(), "btr-home-"));
  process.env.BTR_AGENT = `bun ${join(import.meta.dir, "fixtures/fake-agent.ts")}`;
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "btr-cwd-")));
  await Bun.write(join(cwd, "package.json"), '{ "name": "demo" }\n');
  setup = await createTestRenderer({ width: 120, height: 40, exitOnCtrlC: false });
  // The headless renderer has no terminal to title.
  setup.renderer.setTerminalTitle = () => {};
  const { runTui } = await import("../src/tui");
  app = await runTui({ cwd, renderer: setup.renderer });
});

afterAll(() => {
  app?.agent?.stop();
  setup?.renderer.destroy();
});

/** Renders until the screen satisfies `pred`, and returns it. */
async function screenUntil(pred: (screen: string) => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  let screen = "";
  while (Date.now() < end) {
    await setup.renderOnce();
    screen = setup.captureCharFrame();
    if (pred(screen)) return screen;
    await Bun.sleep(25);
  }
  throw new Error(`the screen never matched:\n${screen}`);
}

const keys = () => setup.mockInput;
async function submit(text: string) {
  await keys().typeText(text);
  keys().pressEnter();
}

test(
  "starts with the welcome line and the status line",
  async () => {
    const screen = await screenUntil((s) => s.includes("btr v") && s.includes("ask · auto") && !s.includes("connecting"));
    expect(screen).toContain("/ for commands");
  },
  TIMEOUT,
);

test(
  "a prompt gets a reply and a closing line",
  async () => {
    await submit("quick");
    const screen = await screenUntil((s) => s.includes("Worked for"));
    expect(screen).toContain("┃ quick");
    expect(screen).toContain("Done. That was the quick one.");
  },
  TIMEOUT,
);

test(
  "tool calls ask first, then fold under the reply",
  async () => {
    await submit("show me a demo");
    let screen = await screenUntil((s) => s.includes("Permission needed"));
    expect(screen).toContain("$ ls -la src");
    keys().pressKey("a");
    screen = await screenUntil((s) => s.includes("Permission needed") && s.includes("greet"));
    expect(screen).toContain("+   const mark = excited");
    keys().pressKey("a");
    // The turn folds once it ends.
    screen = await screenUntil((s) => s.includes("tool calls"));
    expect(screen).toContain("That's all.");
    expect(screen).toMatch(/▸ ⚙ 3 tool calls\s+≡ 1\s+\$ 1\s+✎ 1/);
    expect(screen).toContain("15.4k/128k 12%");
  },
  TIMEOUT,
);

test(
  "the palette opens on /, filters, and closes on esc",
  async () => {
    await keys().typeText("/");
    let screen = await screenUntil((s) => s.includes("Type a command"));
    expect(screen).toContain("New Session");
    await keys().typeText("sidebar");
    screen = await screenUntil((s) => s.includes("> sidebar"));
    expect(screen).toContain("Toggle Sidebar");
    keys().pressEscape();
    await screenUntil((s) => !s.includes("╭"));
  },
  TIMEOUT,
);

test(
  "command keys come from the commands: ctrl+b shows the sidebar",
  async () => {
    keys().pressKey("b", { ctrl: true });
    const screen = await screenUntil((s) => s.includes("Modified Files"));
    expect(screen).toContain("src/greet.ts +3 -2");
    keys().pressKey("b", { ctrl: true });
    await screenUntil((s) => !s.includes("Modified Files"));
  },
  TIMEOUT,
);

test(
  "typed /commands run, and unknown ones are flagged",
  async () => {
    await submit("/status");
    expect(await screenUntil((s) => s.includes("Session Info"))).toContain("Fake Agent 0.0.1");
    await submit("/nosuch");
    await screenUntil((s) => s.includes("Unknown command /nosuch"));
  },
  TIMEOUT,
);

test(
  "! runs a shell command and shows its output",
  async () => {
    await keys().typeText("!");
    await screenUntil((s) => s.includes("shell mode · enter runs"));
    await submit("printf shell-output");
    await screenUntil((s) => s.includes("│ shell-output"));
    expect(app.conversation.shellContext.at(-1)).toContain("$ printf shell-output");
  },
  TIMEOUT,
);

test(
  "esc on a permission request interrupts the turn",
  async () => {
    await submit("another demo");
    await screenUntil((s) => s.includes("Permission needed"));
    keys().pressEscape();
    await screenUntil((s) => s.includes("Cancelled · What should the agent do differently?"));
    expect(app.conversation.busy).toBe(false);
  },
  TIMEOUT,
);
