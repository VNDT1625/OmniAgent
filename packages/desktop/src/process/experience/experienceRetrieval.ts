/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Retrieval service: turn a current problem into a query, rank ExpBase entries
 * by semantic similarity + metadata context match + trust signals, and return
 * concise advisory suggestions.
 *
 * This mirrors the ranking MTUI performs in Rust so the in-app/agent path and
 * the CLI path agree. Operates on the compact projection entries.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { ExperienceProjectionEntry, ExperienceQuery, ExperienceSuggestion } from './experienceTypes';
import { tokenize } from './experienceText';
import { cosineSimilarity, embedOne, type ExperienceEmbedder } from './experienceVectorIndex';

/** Default number of suggestions returned. */
export const DEFAULT_TOP_K = 5;
/** Minimum combined score for a suggestion to be surfaced. */
export const DEFAULT_MIN_SCORE = 0.18;

const RECENCY_HALF_LIFE_DAYS = 180;
const MS_PER_DAY = 86_400_000;

/** Build the natural-language query text embedded/tokenized for ranking. */
export const buildQueryText = (query: ExperienceQuery): string =>
  [
    query.symptom,
    ...(query.errorMessages ?? []),
    query.stackTraceDigest ?? '',
    query.errorCategory ? `errorClass ${query.errorCategory}` : '',
    query.frameworks?.length ? `frameworks ${query.frameworks.join(', ')}` : '',
    query.packages?.length ? `packages ${query.packages.join(', ')}` : '',
    query.commands?.length ? `commands ${query.commands.join(', ')}` : '',
    query.files?.length ? `files ${query.files.join(', ')}` : '',
  ]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n');

/** Fraction of `queryValues` covered by `entryValues` (case-insensitive). */
const overlapFraction = (queryValues: readonly string[], entryValues: readonly string[]): number => {
  if (queryValues.length === 0) {
    return 0;
  }
  const entrySet = new Set(entryValues.map((value) => value.toLowerCase()));
  const matched = queryValues.filter((value) => entrySet.has(value.toLowerCase())).length;
  return matched / queryValues.length;
};

/** Fraction of query files that share a path with an entry file (suffix/prefix match). */
const fileOverlapFraction = (queryFiles: readonly string[], entryFiles: readonly string[]): number => {
  if (queryFiles.length === 0) {
    return 0;
  }
  const normalize = (file: string): string => file.replace(/\\/g, '/').toLowerCase();
  const entryNorm = entryFiles.map(normalize);
  const matched = queryFiles.filter((file) => {
    const q = normalize(file);
    return entryNorm.some((e) => e === q || e.endsWith(q) || q.endsWith(e));
  }).length;
  return matched / queryFiles.length;
};

/** Token-set Jaccard similarity of a query text against an entry's lexical soup. */
const lexicalSimilarity = (queryText: string, lexicalText: string): number => {
  const queryTokens = new Set(tokenize(queryText));
  const entryTokens = new Set(tokenize(lexicalText));
  if (queryTokens.size === 0 || entryTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of queryTokens) {
    if (entryTokens.has(token)) {
      intersection += 1;
    }
  }
  return intersection / queryTokens.size;
};

type ContextMatch = { score: number; why: string[] };

/** Compute the metadata context-match score and human-readable reasons. */
export const computeContextMatch = (query: ExperienceQuery, entry: ExperienceProjectionEntry): ContextMatch => {
  const signals: number[] = [];
  const why: string[] = [];

  if (query.frameworks?.length) {
    const fraction = overlapFraction(query.frameworks, entry.frameworks);
    signals.push(fraction);
    if (fraction > 0) {
      why.push('Same framework');
    }
  }
  if (query.packages?.length) {
    const fraction = overlapFraction(query.packages, entry.packages);
    signals.push(fraction);
    if (fraction > 0) {
      why.push('Same package');
    }
  }
  if (query.commands?.length) {
    const fraction = overlapFraction(query.commands, entry.commands);
    signals.push(fraction);
    if (fraction > 0) {
      why.push('Same command failed');
    }
  }
  if (query.files?.length) {
    const fraction = fileOverlapFraction(query.files, entry.files);
    signals.push(fraction);
    if (fraction > 0) {
      why.push('Same file/subsystem');
    }
  }
  if (query.errorCategory && entry.errorCategory) {
    const match = query.errorCategory.toLowerCase() === entry.errorCategory.toLowerCase() ? 1 : 0;
    signals.push(match);
    if (match > 0) {
      why.push('Same error category');
    }
  }

  const score = signals.length === 0 ? 0 : signals.reduce((sum, value) => sum + value, 0) / signals.length;
  return { score, why };
};

const recencyScore = (updatedAt: string, now: number): number => {
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated)) {
    return 0;
  }
  const days = Math.max(0, (now - updated) / MS_PER_DAY);
  return Math.exp((-days * Math.LN2) / RECENCY_HALF_LIFE_DAYS);
};

const statusPenalty = (status: ExperienceProjectionEntry['status']): number => {
  if (status === 'superseded') {
    return 0.3;
  }
  if (status === 'archived') {
    return 0.6;
  }
  return 0;
};

/** Options controlling {@link rankExperiences}. */
export type RankOptions = {
  /** Normalized query embedding vector; enables the semantic term. */
  queryVector?: number[] | null;
  topK?: number;
  minScore?: number;
  now?: number;
};

/**
 * Rank projection entries against a query, returning advisory suggestions.
 * Archived entries are dropped; superseded entries are penalized and cautioned.
 */
export const rankExperiences = (
  query: ExperienceQuery,
  entries: readonly ExperienceProjectionEntry[],
  options: RankOptions = {}
): ExperienceSuggestion[] => {
  const queryText = buildQueryText(query);
  const now = options.now ?? Date.now();
  const topK = options.topK ?? DEFAULT_TOP_K;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const hasQueryVector = Boolean(options.queryVector && options.queryVector.length > 0);

  const scored = entries
    .filter((entry) => entry.status !== 'archived')
    .map((entry): ExperienceSuggestion => {
      const lexical = lexicalSimilarity(queryText, entry.lexicalText);
      const semantic =
        hasQueryVector && entry.vector && entry.vector.length > 0
          ? cosineSimilarity(options.queryVector as number[], entry.vector)
          : lexical;
      const context = computeContextMatch(query, entry);
      const recency = recencyScore(entry.updatedAt, now);
      const raw =
        0.5 * semantic +
        0.22 * context.score +
        0.1 * entry.confidence +
        0.1 * entry.verificationStrength +
        0.08 * recency -
        statusPenalty(entry.status);
      const score = Math.min(1, Math.max(0, raw));

      const why = [...context.why];
      if (semantic >= 0.5) {
        why.unshift(hasQueryVector && entry.vector ? 'Strong semantic match' : 'Strong keyword match');
      } else if (semantic >= 0.25) {
        why.push(hasQueryVector && entry.vector ? 'Partial semantic match' : 'Partial keyword match');
      }

      return {
        entryId: entry.id,
        score,
        kind: entry.kind,
        symptom: entry.symptom,
        lesson: entry.lesson,
        whyRelevant: why.length > 0 ? why : ['Loosely related symptom'],
        caution: entry.caution,
        suggestedChecks: entry.suggestedChecks,
      };
    })
    .filter((suggestion) => suggestion.score >= minScore)
    .toSorted((a, b) => b.score - a.score || b.entryId.localeCompare(a.entryId));

  return scored.slice(0, topK);
};

/** Dependencies for {@link createExperienceRetrieval}. */
export type ExperienceRetrievalDeps = {
  embedder?: ExperienceEmbedder | null;
  now?: () => number;
};

/** Create a retrieval service that embeds the query (when possible) then ranks. */
export const createExperienceRetrieval = (deps: ExperienceRetrievalDeps = {}) => {
  const retrieve = async (
    query: ExperienceQuery,
    entries: readonly ExperienceProjectionEntry[],
    options: { topK?: number; minScore?: number } = {}
  ): Promise<ExperienceSuggestion[]> => {
    let queryVector: number[] | null = null;
    if (deps.embedder) {
      try {
        queryVector = await embedOne(deps.embedder, buildQueryText(query));
      } catch {
        queryVector = null;
      }
    }
    return rankExperiences(query, entries, {
      queryVector,
      topK: options.topK,
      minScore: options.minScore,
      now: deps.now?.(),
    });
  };

  return { retrieve };
};
