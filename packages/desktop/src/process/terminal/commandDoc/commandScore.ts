/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PURE scoring + ranking for docTerminal suggestions.
 *
 * Combines a lexical match against the user's current input (prefix > substring
 * > fuzzy subsequence) with frequency and recency. The top strict-prefix result
 * drives the ghost-text completion ({@link bestGhost}); {@link rankCommands}
 * drives the dropdown. No I/O — deterministic given an injected `now`.
 */

import {
  FREQUENCY_CAP,
  RECENCY_HALF_LIFE_MS,
  SCORE_WEIGHTS,
  type CommandRecord,
  type CommandSuggestion,
} from './commandTypes';

/** Result of {@link matchScore}: a lexical score and whether it is a strict prefix. */
export type MatchResult = { score: number; isPrefix: boolean };

/** Frequency component in [0, 1], saturating at {@link FREQUENCY_CAP}. */
export const frequencyScore = (count: number): number => Math.min(1, Math.max(0, count) / FREQUENCY_CAP);

/** Recency component in [0, 1] via exponential decay with a 1-week half-life. */
export const recencyScore = (lastUsedAt: number, now: number): number => {
  const age = Math.max(0, now - lastUsedAt);
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
};

/**
 * Lexical match of `input` against `command`:
 *  - strict prefix → `{ score: 1, isPrefix: true }`
 *  - substring     → `{ score: 0.7, isPrefix: false }`
 *  - subsequence   → `{ score: 0.4, isPrefix: false }`
 *  - no match      → `{ score: 0, isPrefix: false }`
 * Empty input → `{ score: 0, isPrefix: false }`.
 */
export const matchScore = (input: string, command: string): MatchResult => {
  const q = input.trim().toLowerCase();
  if (q.length === 0) return { score: 0, isPrefix: false };
  const c = command.toLowerCase();
  if (c.startsWith(q)) return { score: 1, isPrefix: true };
  if (c.includes(q)) return { score: 0.7, isPrefix: false };
  let qi = 0;
  for (let ci = 0; ci < c.length && qi < q.length; ci += 1) {
    if (c[ci] === q[qi]) qi += 1;
  }
  return qi === q.length ? { score: 0.4, isPrefix: false } : { score: 0, isPrefix: false };
};

/** Options for {@link rankCommands} / {@link bestGhost}. */
export type RankOptions = {
  /** The user's current line input (may be empty). */
  prefix: string;
  /** Epoch ms "now" for recency. */
  now: number;
};

/**
 * Rank command records for the current input. When `prefix` is non-empty, only
 * records with a positive lexical match are kept (non-matching records dropped).
 *
 * @param records The known commands.
 * @param options Prefix + clock.
 * @param limit Max suggestions (default 8).
 * @returns Suggestions sorted best-first.
 */
export const rankCommands = (
  records: readonly CommandRecord[],
  options: RankOptions,
  limit = 8
): CommandSuggestion[] => {
  const hasPrefix = options.prefix.trim().length > 0;
  const out: CommandSuggestion[] = [];
  for (const record of records) {
    const match = matchScore(options.prefix, record.command);
    if (hasPrefix && match.score === 0) continue;
    const score =
      SCORE_WEIGHTS.match * match.score +
      SCORE_WEIGHTS.frequency * frequencyScore(record.count) +
      SCORE_WEIGHTS.recency * recencyScore(record.lastUsedAt, options.now);
    out.push({
      command: record.command,
      score: Number(score.toFixed(4)),
      completion: match.isPrefix ? record.command.slice(options.prefix.length) : '',
      count: record.count,
    });
  }
  return out
    .toSorted((a, b) => b.score - a.score || b.count - a.count || a.command.localeCompare(b.command))
    .slice(0, Math.max(0, limit));
};

/**
 * The single best ghost-text suggestion: the highest-ranked STRICT-prefix match
 * whose command is longer than the input (so there is a tail to append), or null.
 *
 * @param records The known commands.
 * @param options Prefix + clock.
 * @returns The best ghost suggestion, or null.
 */
export const bestGhost = (records: readonly CommandRecord[], options: RankOptions): CommandSuggestion | null => {
  const prefix = options.prefix;
  if (prefix.trim().length === 0) return null;
  const eligible = records.filter(
    (r) => r.command.toLowerCase().startsWith(prefix.toLowerCase()) && r.command.length > prefix.length
  );
  const [best] = rankCommands(eligible, options, 1);
  return best ?? null;
};
