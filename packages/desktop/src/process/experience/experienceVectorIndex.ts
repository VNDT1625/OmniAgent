/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vector helpers for the ExpBase engine: embedding via an injected provider and
 * pure cosine ranking. Mirrors the math in `ide/vectorIndex.ts` but operates on
 * whole-entry embedding texts rather than source chunks.
 *
 * Embedding is OPTIONAL: callers degrade to lexical + metadata ranking when no
 * embedder is configured, so the hot retrieval path never blocks on a model.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { Embedder } from '@process/ide/vectorIndex';

/** Re-exported for callers that wire a real embedding provider. */
export type ExperienceEmbedder = Embedder;

const magnitude = (vector: readonly number[]): number => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

/** Return a unit-length copy of `vector` (or all-zeros when the input is zero). */
export const normalizeVector = (vector: readonly number[]): number[] => {
  const mag = magnitude(vector);
  if (mag <= 0) {
    return vector.map(() => 0);
  }
  return vector.map((value) => value / mag);
};

/**
 * Cosine similarity of two vectors. When both inputs are already normalized this
 * is just their dot product; the result is clamped to `[0, 1]` for ranking.
 */
export const cosineSimilarity = (a: readonly number[], b: readonly number[]): number => {
  const length = Math.min(a.length, b.length);
  if (length === 0) {
    return 0;
  }
  let dot = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
  }
  return Math.min(1, Math.max(0, dot));
};

/**
 * Embed a batch of texts and normalize each vector. Returns one entry per input
 * text; a text whose provider vector is empty maps to `null`.
 */
export const embedNormalized = async (
  embedder: ExperienceEmbedder,
  texts: readonly string[],
  signal?: AbortSignal
): Promise<Array<number[] | null>> => {
  if (texts.length === 0) {
    return [];
  }
  const vectors = await embedder.embed(texts, signal);
  return texts.map((_, index) => {
    const vector = vectors[index];
    return vector && vector.length > 0 ? normalizeVector(vector) : null;
  });
};

/** Embed a single text, returning a normalized vector or `null`. */
export const embedOne = async (
  embedder: ExperienceEmbedder,
  text: string,
  signal?: AbortSignal
): Promise<number[] | null> => {
  const [vector] = await embedNormalized(embedder, [text], signal);
  return vector ?? null;
};

/** A candidate carrying a stored vector for cosine ranking. */
export type VectorCandidate = {
  id: string;
  vector?: number[];
};

/** Rank candidates by cosine similarity to a (normalized) query vector. */
export const rankByVector = (
  queryVector: readonly number[],
  candidates: readonly VectorCandidate[]
): Map<string, number> => {
  const scores = new Map<string, number>();
  if (queryVector.length === 0) {
    return scores;
  }
  for (const candidate of candidates) {
    if (candidate.vector && candidate.vector.length > 0) {
      scores.set(candidate.id, cosineSimilarity(queryVector, candidate.vector));
    }
  }
  return scores;
};
