import { VERSION } from "./version";

export const HELP = `btr ${VERSION} — a terminal interface for GitHub Copilot and other ACP agents

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

export type Args = {
  /** What to do: run (the interface, or print mode), or show help or the version. */
  action: "run" | "help" | "version";
  print: boolean;
  continueLast: boolean;
  allowAll: boolean;
  /** A session id, or true to pick one. */
  resume?: string | boolean;
  model: string;
  mode: string;
  prompt: string;
};

/** A mistake on the command line. */
export class UsageError extends Error {}

export function parseArgs(argv: string[]): Args {
  const o: Args = { action: "run", print: false, continueLast: false, allowAll: false, model: "", mode: "", prompt: "" };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "-h" || a === "--help") return { ...o, action: "help" };
    else if (a === "-v" || a === "--version") return { ...o, action: "version" };
    else if (a === "-p" || a === "--print") o.print = true;
    else if (a === "-c" || a === "--continue") o.continueLast = true;
    else if (a === "--allow-all") o.allowAll = true;
    else if (a === "-r" || a === "--resume") {
      const next = argv[i + 1];
      // A session id follows only when it looks like one; a prompt may follow instead.
      if (next && !next.startsWith("-") && /^[\w-]{8,}$/.test(next)) o.resume = argv[++i]!;
      else o.resume = true;
    } else if (a === "--model") o.model = value();
    else if (a === "--mode") o.mode = value();
    else if (a.startsWith("--model=")) o.model = a.slice(8);
    else if (a.startsWith("--mode=")) o.mode = a.slice(7);
    else if (a === "--") {
      words.push(...argv.slice(i + 1));
      break;
    } else if (a.startsWith("-") && a !== "-") throw new UsageError(`unknown option ${a}`);
    else words.push(a);
  }
  o.prompt = words.join(" ");
  return o;
}
