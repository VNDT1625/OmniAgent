/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `keywordFilter` — Tier 1 of tool selection (Yêu cầu 7, criterion 7.3): match a
 * request's words against each catalog entry's name/description/keywords and
 * rank by overlap. Cheap, synchronous, no model — runs first so the (smaller)
 * top-k can optionally be re-ranked semantically (Tier 2).
 *
 * Pure module: deterministic, no IO, easy to unit-test. Main-process safe.
 */

import type { CatalogEntry, ScoredEntry } from './catalogTypes';

/** Tunables for {@link keywordFilter}. */
export type KeywordFilterOptions = {
  /** Max results to return. Defaults to 10. */
  limit?: number;
  /** Drop entries scoring at/below this threshold. Defaults to 0 (keep any match). */
  minScore?: number;
};

/** Split text into lowercased word tokens (letters/digits), dropping tiny stopwords. */
const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'is', 'it', 'do', 'me', 'my']);

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));

/**
 * Score one entry against the request token set. Name matches weigh most, then
 * explicit keywords, then description matches. Returns 0 when nothing overlaps.
 */
const scoreEntry = (entry: CatalogEntry, requestTokens: Set<string>): { score: number; hits: string[] } => {
  const nameTokens = new Set(tokenize(entry.name));
  const descTokens = new Set(tokenize(entry.description));
  const keywordTokens = new Set((entry.keywords ?? []).flatMap((k) => tokenize(k)));

  let score = 0;
  const hits: string[] = [];
  for (const token of requestTokens) {
    if (nameTokens.has(token)) {
      score += 3;
      hits.push(token);
    } else if (keywordTokens.has(token)) {
      score += 2;
      hits.push(token);
    } else if (descTokens.has(token)) {
      score += 1;
      hits.push(token);
    }
  }
  return { score, hits };
};

/**
 * Rank `entries` against a free-text `request` by keyword overlap (Tier 1).
 *
 * @param request The user's request text.
 * @param entries The catalog to filter.
 * @param options limit / minScore tuning.
 * @returns Matching entries sorted by descending score (ties broken by name).
 */
export const keywordFilter = (
  request: string,
  entries: readonly CatalogEntry[],
  options: KeywordFilterOptions = {}
): ScoredEntry[] => {
  const limit = options.limit ?? 10;
  const minScore = options.minScore ?? 0;
  const requestTokens = new Set(tokenize(request));
  if (requestTokens.size === 0) return [];

  const scored: ScoredEntry[] = [];
  for (const entry of entries) {
    const { score, hits } = scoreEntry(entry, requestTokens);
    if (score > minScore) {
      scored.push({ entry, score, reason: `keyword match: ${hits.join(', ')}` });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return scored.slice(0, limit);
};
