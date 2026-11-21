import { tmpdir } from "node:os";
import { join } from "node:path";

/** Copies `text` with the system clipboard tool. False when there is none (only macOS has one here). */
export async function copyText(text: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const proc = Bun.spawn(["pbcopy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  proc.stdin.write(text);
  proc.stdin.end();
  return (await proc.exited) === 0;
}

/** The image on the system clipboard as PNG bytes, or null when there is none. macOS only. */
export async function readImage(): Promise<Uint8Array | null> {
  if (process.platform !== "darwin") return null;
  const file = join(tmpdir(), `btr-clipboard-${process.pid}.png`);
  const script = [
    "set png to the clipboard as «class PNGf»",
    `set f to open for access POSIX file ${JSON.stringify(file)} with write permission`,
    "set eof f to 0",
    "write png to f",
    "close access f",
  ];
  try {
    const proc = Bun.spawn(["osascript", ...script.flatMap((line) => ["-e", line])], { stdout: "ignore", stderr: "ignore" });
    if ((await proc.exited) !== 0) return null;
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    await Bun.file(file).delete().catch(() => {});
    return bytes.length ? bytes : null;
  } catch {
    return null;
  }
}
