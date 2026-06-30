/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `nearestName` — pick the closest valid identifier to a misspelt/renamed one,
 * used by the invalid-icon detector to map e.g. `GitBranch` → `Branch` when a
 * library drops or renames an export. Pure function, no I/O.
 *
 * Uses Levenshtein edit distance with a relative-distance guard so we only
 * suggest a replacement that is genuinely close (avoids confidently rewriting an
 * import to an unrelated symbol). Ties broken by the shorter candidate, then
 * lexicographically, for deterministic output.
 *
 * Process boundary: Main-process (Node.js) pure module — no DOM, no runtime.
 */

/** Compute the Levenshtein edit distance between two strings. */
export const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Single-row rolling DP — O(min) memory.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
};

/** Result of a nearest-name lookup. */
export type NearestNameMatch = {
  /** The closest candidate. */
  name: string;
  /** Edit distance to the target. */
  distance: number;
};

/**
 * Find the candidate closest to `target`. Returns `undefined` when no candidate
 * is "close enough": the distance must be `<= maxDistance` AND at most
 * `maxRatio` of the target length, so a short name cannot match something wildly
 * different (e.g. `Tag` should not map to a 2-edit unrelated icon).
 *
 * @param target The (invalid) identifier to replace.
 * @param candidates Valid identifiers to choose from.
 * @param opts `maxDistance` (default 4) and `maxRatio` (default 0.5).
 */
export const nearestName = (
  target: string,
  candidates: Iterable<string>,
  opts: { maxDistance?: number; maxRatio?: number } = {}
): NearestNameMatch | undefined => {
  const maxDistance = opts.maxDistance ?? 4;
  const maxRatio = opts.maxRatio ?? 0.5;
  const limit = Math.min(maxDistance, Math.floor(target.length * maxRatio));
  if (limit < 1) return undefined;

  let best: NearestNameMatch | undefined;
  for (const candidate of candidates) {
    if (candidate === target) return { name: candidate, distance: 0 };
    const distance = levenshtein(target, candidate);
    if (distance > limit) continue;
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && candidate.length < best.name.length) ||
      (distance === best.distance && candidate.length === best.name.length && candidate < best.name)
    ) {
      best = { name: candidate, distance };
    }
  }
  return best;
};
