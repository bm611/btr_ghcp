import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { COPILOT_HOME } from "../agent/copilot";
import { errorText, tildify, trunc } from "../core/format";
import type { MenuOption } from "../ui/menu";
import { G } from "../ui/theme";
import type { Entry, InputMode, Item } from "../ui/transcript";
import type { App } from "./app";

export type OtherMode = Exclude<InputMode, "prompt">;

/**
 * The prompt's modes besides the plain prompt. A mode's `trigger`, typed alone on an empty
 * prompt, switches to it, and marks its entries in the history. Enter in it runs the mode's
 * entry in `createModes` below.
 */
export const MODES: Record<OtherMode, { trigger: string; rail: string; placeholder: string; status: string }> = {
  bash: { trigger: "!", rail: "$", placeholder: "Run a shell command", status: "shell mode · enter runs · esc leaves" },
  memory: { trigger: "#", rail: "#", placeholder: "Add a note to your instructions", status: "note mode · enter saves · esc leaves" },
};

/** The mode a history entry was typed in, from its trigger. */
export function modeOf(entry: string): OtherMode | undefined {
  return (Object.keys(MODES) as OtherMode[]).find((m) => entry.startsWith(MODES[m].trigger));
}

export type Modes = ReturnType<typeof createModes>;

export function createModes(app: App) {
  let shell: ReturnType<typeof Bun.spawn> | null = null;

  /** Runs a command the user typed, showing its output as it comes. The output joins the next prompt. */
  async function runShell(command: string) {
    const { transcript } = app;
    const entry: Entry<Extract<Item, { type: "user" }>> = transcript.add({ type: "user", text: command, mode: "bash", result: { text: `Running${G.ellipsis}` } });
    let output = "";
    let dirty = false;
    const paint = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      entry.item.result = { text: Bun.stripANSI(output).trimEnd() || `Running${G.ellipsis}` };
      transcript.update(entry);
    }, 120);
    try {
      const proc = Bun.spawn([process.env.SHELL ?? "sh", "-c", command], { cwd: app.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      shell = proc;
      const read = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
          output += decoder.decode(chunk, { stream: true });
          dirty = true;
        }
      };
      await Promise.all([read(proc.stdout), read(proc.stderr)]);
      const code = await proc.exited;
      // Escape sequences in command output would corrupt the layout.
      output = Bun.stripANSI(output).trimEnd();
      entry.item.result = { text: output || "(no output)", tone: code === 0 ? "dim" : "error" };
      app.conversation.shellContext.push(
        `I ran this shell command myself:\n$ ${command}\n${output.slice(0, 20000) || "(no output)"}${code ? `\n(exit code ${code})` : ""}`,
      );
    } catch (err) {
      entry.item.result = { text: errorText(err), tone: "error" };
    } finally {
      clearInterval(paint);
      shell = null;
      transcript.update(entry);
    }
  }

  /** Appends a note to an instructions file the user picks. */
  async function saveNote(memo: string) {
    const { cwd, transcript } = app;
    const targets: MenuOption[] = [
      { label: "Project instructions", value: join(cwd, "AGENTS.md"), hint: "AGENTS.md" },
      { label: "Project Copilot instructions", value: join(cwd, ".github", "copilot-instructions.md"), hint: ".github/copilot-instructions.md" },
      { label: "User instructions", value: join(COPILOT_HOME, "copilot-instructions.md"), hint: `${tildify(COPILOT_HOME)}/…` },
    ];
    const file = await app.menus.open({ title: "Save Note", question: `Where should "${trunc(memo, 50)}" be saved?`, options: targets });
    if (!file) return;
    try {
      await mkdir(dirname(file), { recursive: true });
      const existing = (await Bun.file(file).exists()) ? await Bun.file(file).text() : "";
      await appendFile(file, `${existing && !existing.endsWith("\n") ? "\n" : ""}- ${memo}\n`);
      transcript.add({ type: "user", text: memo, mode: "memory", result: { text: `Saved to ${tildify(file)}` } });
    } catch (err) {
      transcript.note(`Could not save the note: ${errorText(err)}`, "error");
    }
  }

  const run: Record<OtherMode, (text: string) => Promise<void>> = { bash: runShell, memory: saveNote };

  return {
    run: (mode: OtherMode, text: string) => run[mode](text),
    get shellRunning() {
      return shell !== null;
    },
    killShell() {
      shell?.kill();
    },
  };
}
