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

/** The best `limit` matches for `query`, best first; the first `limit` items when the query is empty. */
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
