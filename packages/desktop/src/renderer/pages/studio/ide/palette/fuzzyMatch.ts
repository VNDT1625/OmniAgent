/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure fuzzy matching for the IDE command palette (Ctrl+P file open / command
 * run). Dependency-free so it is trivially unit-testable and reusable.
 *
 * The algorithm is a subsequence matcher with a small, predictable score:
 *  - every query char must appear in order in the candidate (case-insensitive);
 *  - consecutive matches, matches at a word boundary (start, after `/._-` or a
 *    camelCase hump) and matches near the start score higher;
 *  - the basename (segment after the last `/`) is weighted above the full path,
 *    so typing `button` ranks `ui/Button.tsx` above `x/button-helpers/y.ts`.
 *
 * `fuzzyScore` returns null on no match; `fuzzyFilter` ranks + caps a list.
 */

/** A scored candidate with the indices of the matched characters (for highlight). */
export type FuzzyMatch<T> = {
  item: T;
  score: number;
  /** Indices into the matched STRING (the `toText(item)` result) that matched. */
  indices: number[];
};

const isWordBoundary = (text: string, i: number): boolean => {
  if (i === 0) return true;
  const prev = text[i - 1];
  const cur = text[i];
  if (prev === '/' || prev === '\\' || prev === '.' || prev === '_' || prev === '-' || prev === ' ') return true;
  // camelCase hump: lower→Upper.
  if (prev >= 'a' && prev <= 'z' && cur >= 'A' && cur <= 'Z') return true;
  return false;
};

/**
 * Score `query` against `text`. Returns null when `query` is not a subsequence
 * of `text`. Higher is better. Empty query scores 0 (matches everything).
 */
export const fuzzyScore = (query: string, text: string): { score: number; indices: number[] } | null => {
  if (query.length === 0) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let lastMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (; ti < t.length; ti++) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
    }
    if (found === -1) return null;
    indices.push(found);
    // Base point per matched char.
    score += 1;
    // Consecutive match bonus — weighted ABOVE a word-boundary hit so a tight
    // run inside a real word (e.g. "but" in "button") beats the same chars
    // scattered across separators (e.g. "b_u_t").
    if (found === lastMatch + 1) score += 10;
    // Word-boundary bonus.
    if (isWordBoundary(text, found)) score += 8;
    // Earlier matches are slightly better.
    score += Math.max(0, 3 - found * 0.05);
    lastMatch = found;
    ti = found + 1;
  }
  return { score, indices };
};

/** The basename of a `/`- or `\`-separated path (or the whole string). */
export const basename = (path: string): string => {
  const norm = path.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? norm : norm.slice(idx + 1);
};

/**
 * Rank `items` by fuzzy match of `query` against `toText(item)`, weighting a
 * basename match above a full-path match. Returns the top `limit` matches,
 * best first. An empty query returns the first `limit` items unscored.
 */
export const fuzzyFilter = <T>(
  query: string,
  items: readonly T[],
  toText: (item: T) => string,
  limit = 50
): FuzzyMatch<T>[] => {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return items.slice(0, limit).map((item) => ({ item, score: 0, indices: [] as number[] }));
  }
  const matches: FuzzyMatch<T>[] = [];
  for (const item of items) {
    const text = toText(item);
    const full = fuzzyScore(trimmed, text);
    if (!full) continue;
    // Re-score against the basename and take the better of the two, offsetting
    // the basename indices back into the full string for highlight.
    const base = basename(text);
    const baseOffset = text.length - base.length;
    const baseScore = fuzzyScore(trimmed, base);
    let best = full;
    if (baseScore && baseScore.score + 6 > full.score) {
      best = { score: baseScore.score + 6, indices: baseScore.indices.map((i) => i + baseOffset) };
    }
    // Shorter candidates win ties (more specific).
    matches.push({ item, score: best.score - text.length * 0.02, indices: best.indices });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, limit);
};
