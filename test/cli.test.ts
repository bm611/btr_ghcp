import { expect, test } from "bun:test";
import { UsageError, parseArgs } from "../src/cli";

test("words become the prompt; flags set options", () => {
  expect(parseArgs(["fix", "the", "bug"])).toMatchObject({ action: "run", prompt: "fix the bug", print: false });
  expect(parseArgs(["-p", "--allow-all", "--model", "gpt", "--mode=plan", "hi"])).toMatchObject({
    print: true,
    allowAll: true,
    model: "gpt",
    mode: "plan",
    prompt: "hi",
  });
  expect(parseArgs(["--", "-p", "is", "text"]).prompt).toBe("-p is text");
});

test("--resume takes an id only when one follows", () => {
  expect(parseArgs(["-r", "sess-12345678"]).resume).toBe("sess-12345678");
  expect(parseArgs(["-r", "why"]).resume).toBe(true);
  expect(parseArgs(["-r", "why"]).prompt).toBe("why");
  expect(parseArgs(["--resume"]).resume).toBe(true);
});

test("help and version, and mistakes", () => {
  expect(parseArgs(["-h"]).action).toBe("help");
  expect(parseArgs(["x", "--version"]).action).toBe("version");
  expect(() => parseArgs(["--nope"])).toThrow(UsageError);
  expect(() => parseArgs(["--model"])).toThrow("--model needs a value");
});
