import { dirname } from "node:path";

const MAX_FILES = 20000;
const TTL_MS = 5000;

let cache: { cwd: string; at: number; paths: string[] } | null = null;
let pending: Promise<string[]> | null = null;

async function scan(cwd: string): Promise<string[]> {
  let files: string[] = [];
  try {
    const git = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(git.stdout).text();
    if ((await git.exited) === 0) files = out.split("\n").filter(Boolean);
    else throw new Error("not a git repository");
  } catch {
    const glob = new Bun.Glob("**/*");
    for await (const f of glob.scan({ cwd, onlyFiles: true, dot: false })) {
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

/** Resolves once the first scan of `cwd` is in. */
export async function filesReady(cwd: string) {
  listFiles(cwd);
  await pending;
}

/**
 * Scores `text` against `query` as a case-insensitive subsequence: higher is better, -1 is no match.
 * Matches at the start of a path segment or right after the previous match count for more.
 */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  let score = 0;
  let from = 0;
  let last = -2;
  for (const ch of q) {
    const i = s.indexOf(ch, from);
    if (i < 0) return -1;
    score += 1;
    if (i === last + 1) score += 4;
    if (i === 0 || "/._- ".includes(s[i - 1]!)) score += 3;
    last = i;
    from = i + 1;
  }
  const base = s.lastIndexOf("/", s.length - 2) + 1;
  if (s.slice(base).startsWith(q)) score += 12;
  else if (s.includes(q)) score += 6;
  return score - text.length / 200;
}

export function fuzzyFilter<T>(query: string, items: T[], key: (item: T) => string, limit: number): T[] {
  if (!query) return items.slice(0, limit);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, key(item));
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}
