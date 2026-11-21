#!/usr/bin/env bun
import { fstat as fstatCb } from "node:fs";
import { promisify } from "node:util";
import { HELP, UsageError, parseArgs } from "./cli";
import { VERSION } from "./version";

const fstat = promisify(fstatCb);

function fail(message: string): never {
  console.error(`btr: ${message}\nRun btr --help for usage.`);
  process.exit(2);
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) fail(err.message);
  throw err;
}
if (args.action === "help") {
  console.log(HELP);
  process.exit(0);
}
if (args.action === "version") {
  console.log(VERSION);
  process.exit(0);
}

const cwd = process.cwd();
let prompt = args.prompt;

if (args.print) {
  // Read stdin only when it is a pipe or a file: an inherited stdin of another kind may never close.
  const stdin = process.stdin.isTTY ? null : await fstat(0).catch(() => null);
  if (stdin && (stdin.isFIFO() || stdin.isFile())) {
    const piped = (await Bun.stdin.text()).trim();
    if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped;
  }
  if (!prompt) fail("--print needs a prompt, as an argument or on stdin");
  if (args.resume === true) fail("--print cannot show the session picker: pass --resume <id> or --continue");
  const { runPrint } = await import("./print");
  process.exit(
    await runPrint({ cwd, prompt, allowAll: args.allowAll, resume: args.resume || undefined, continueLast: args.continueLast, model: args.model, mode: args.mode }),
  );
}

if (!process.stdout.isTTY || !process.stdin.isTTY) fail("the interface needs a terminal; use --print for scripts");

const { runTui } = await import("./tui");
await runTui({ cwd, prompt: prompt || undefined, resume: args.resume, continueLast: args.continueLast, model: args.model || undefined, mode: args.mode || undefined });
