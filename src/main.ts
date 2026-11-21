#!/usr/bin/env bun
import { fstat as fstatCb } from "node:fs";
import { promisify } from "node:util";
import { VERSION } from "./agent";

const fstat = promisify(fstatCb);

const HELP = `btr ${VERSION} — a terminal interface for GitHub Copilot and other ACP agents

Usage: btr [options] [prompt]

  With no options, opens the interface in the current directory. A prompt
  given on the command line is sent as the first message.

Options:
  -p, --print            Print the reply to the prompt and exit (reads stdin when piped)
  -c, --continue         Continue the most recent conversation in this directory
  -r, --resume [id]      Resume a conversation by id, or pick one from a list
      --model <name>     Start with this model
      --mode <name>      Start in this mode (agent, plan, autopilot)
      --allow-all        With --print: approve every tool call instead of declining
  -h, --help             Show this help
  -v, --version          Show the version

Environment:
  BTR_AGENT              The agent command (default: "copilot --acp --model auto")
  BTR_HOME               Where settings and history live (default: ~/.btr)
`;

function parseArgs(argv: string[]) {
  const o = { print: false, continueLast: false, allowAll: false, resume: undefined as string | boolean | undefined, model: "", mode: "", prompt: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === "-h" || a === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (a === "-v" || a === "--version") {
      console.log(VERSION);
      process.exit(0);
    } else if (a === "-p" || a === "--print") o.print = true;
    else if (a === "-c" || a === "--continue") o.continueLast = true;
    else if (a === "--allow-all") o.allowAll = true;
    else if (a === "-r" || a === "--resume") {
      const next = argv[i + 1];
      // A session id follows only when it looks like one; a prompt may follow instead.
      if (next && !next.startsWith("-") && /^[\w-]{8,}$/.test(next) && !next.includes(" ")) o.resume = argv[++i]!;
      else o.resume = true;
    } else if (a === "--model") o.model = value();
    else if (a === "--mode") o.mode = value();
    else if (a.startsWith("--model=")) o.model = a.slice(8);
    else if (a.startsWith("--mode=")) o.mode = a.slice(7);
    else if (a === "--") {
      o.prompt.push(...argv.slice(i + 1));
      break;
    } else if (a.startsWith("-") && a !== "-") fail(`unknown option ${a}`);
    else o.prompt.push(a);
  }
  return o;
}

function fail(message: string): never {
  console.error(`btr: ${message}\nRun btr --help for usage.`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
const cwd = process.cwd();
let prompt = args.prompt.join(" ");

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
