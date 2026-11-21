import { dirname } from "node:path";

const MAX_FILES = 20000;
const TTL_MS = 5000;

let cache: { cwd: string; at: number; paths: string[] } | null = null;
let pending: Promise<string[]> | null = null;

async function scan(cwd: string): Promise<string[]> {
  let files: string[] = [];
  try {
    const git = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(git.stdout).text();
    if ((await git.exited) !== 0) throw new Error("not a git repository");
    files = out.split("\n").filter(Boolean);
  } catch {
    for await (const f of new Bun.Glob("**/*").scan({ cwd, onlyFiles: true, dot: false })) {
      if (f.startsWith("node_modules/") || f.includes("/node_modules/")) continue;
      files.push(f);
      if (files.length >= MAX_FILES) break;
    }
  }
  files = files.slice(0, MAX_FILES);
  const dirs = new Set<string>();
  for (const f of files) {
    for (let d = dirname(f); d !== "." && !dirs.has(d); d = dirname(d)) dirs.add(d);
  }
  return [...[...dirs].map((d) => d + "/"), ...files].sort();
}

/** Paths under `cwd`, relative to it; directories end in "/". Cached briefly, and refreshed in the background. */
export function listFiles(cwd: string): string[] {
  const fresh = cache && cache.cwd === cwd && Date.now() - cache.at < TTL_MS;
  if (!fresh && !pending) {
    pending = scan(cwd)
      .then((paths) => {
        cache = { cwd, at: Date.now(), paths };
        return paths;
      })
      .finally(() => {
        pending = null;
      });
  }
  return cache?.cwd === cwd ? cache.paths : [];
}
