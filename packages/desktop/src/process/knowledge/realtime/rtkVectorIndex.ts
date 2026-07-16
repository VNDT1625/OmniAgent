/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Semantic vector index for Realtime Knowledge facts.
 *
 * One vector per fact (its `embeddingText`). Built on the same primitives as the
 * IDE `vectorIndex.ts` — L2-normalised vectors + cosine similarity — but scoped
 * to facts instead of code chunks. The {@link Embedder} abstraction is reused so
 * production wiring can plug in the user's configured embedding model.
 *
 * The index is held in memory and is fully serialisable (plain JSON), so callers
 * can persist it next to the facts store and reload it on boot.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { Embedder } from '../../ide/vectorIndex';

export type { Embedder } from '../../ide/vectorIndex';

/** Persisted schema version of the realtime-knowledge vector index. */
export const RTK_VECTOR_INDEX_VERSION = 1;

/** One indexed fact vector. */
export type RtkVectorEntry = {
  /** The fact id this vector belongs to. */
  factId: string;
  /** A hash of the embedding text, so we can skip re-embedding unchanged facts. */
  fingerprint: string;
  /** The L2-normalised embedding vector. */
  vector: number[];
};

/** Serialisable index document. */
export type RtkVectorIndexData = {
  version: number;
  providerId: string;
  model: string;
  dimensions: number;
  entries: RtkVectorEntry[];
};

/** A ranked retrieval hit. */
export type RtkVectorHit = {
  factId: string;
  /** Cosine similarity in [0, 1] (clamped at 0). */
  score: number;
};

/** A live, queryable realtime-knowledge vector index. */
export type IRtkVectorIndex = {
  /** Embed `text` for `factId` and upsert it (skips work if the fingerprint matches). */
  upsert(factId: string, text: string, signal?: AbortSignal): Promise<void>;
  /** Remove a fact's vector. Returns whether one was removed. */
  remove(factId: string): boolean;
  /** Rank facts by semantic similarity to `query`. Returns up to `topK` hits. */
  query(query: string, topK: number, signal?: AbortSignal): Promise<RtkVectorHit[]>;
  /** Snapshot the index as a serialisable document. */
  toData(): RtkVectorIndexData;
};

/** FNV-1a 32-bit hash of a string, hex-encoded — cheap, deterministic fingerprint. */
export const fingerprintText = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const magnitude = (vector: readonly number[]): number =>
  Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

/** L2-normalise a vector (zero vector stays zero). */
export const normalizeVector = (vector: readonly number[]): number[] => {
  const mag = magnitude(vector);
  if (mag <= 0) return vector.map(() => 0);
  return vector.map((value) => value / mag);
};

/** Dot product of two (already-normalised) vectors = cosine similarity. */
export const cosine = (a: readonly number[], b: readonly number[]): number => {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
  }
  return dot;
};

/**
 * Create an {@link IRtkVectorIndex} backed by `embedder`.
 *
 * @param embedder The embedding model wrapper (provider id + model + `embed`).
 * @param initial Optional persisted data to rehydrate from (version/model are
 *   validated; a mismatch starts empty so a model change rebuilds cleanly).
 */
export const createRtkVectorIndex = (embedder: Embedder, initial?: RtkVectorIndexData | null): IRtkVectorIndex => {
  const reusable =
    initial &&
    initial.version === RTK_VECTOR_INDEX_VERSION &&
    initial.providerId === embedder.providerId &&
    initial.model === embedder.model
      ? initial
      : null;

  const entries = new Map<string, RtkVectorEntry>();
  let dimensions = reusable?.dimensions ?? 0;
  for (const entry of reusable?.entries ?? []) {
    entries.set(entry.factId, entry);
  }

  const upsert: IRtkVectorIndex['upsert'] = async (factId, text, signal) => {
    const fingerprint = fingerprintText(text);
    const existing = entries.get(factId);
    if (existing && existing.fingerprint === fingerprint) {
      return; // unchanged — skip re-embedding
    }
    const [raw] = await embedder.embed([text], signal);
    if (!raw || raw.length === 0) {
      return; // embedder produced nothing usable; leave any prior vector intact
    }
    const vector = normalizeVector(raw);
    dimensions = vector.length;
    entries.set(factId, { factId, fingerprint, vector });
  };

  const remove: IRtkVectorIndex['remove'] = (factId) => entries.delete(factId);

  const query: IRtkVectorIndex['query'] = async (queryText, topK, signal) => {
    if (entries.size === 0) return [];
    const [raw] = await embedder.embed([queryText], signal);
    const normalizedQuery = normalizeVector(raw ?? []);
    if (normalizedQuery.length === 0) return [];
    const hits: RtkVectorHit[] = [];
    for (const entry of entries.values()) {
      const score = Math.max(0, cosine(normalizedQuery, entry.vector));
      if (score > 0) hits.push({ factId: entry.factId, score });
    }
    return hits.toSorted((a, b) => b.score - a.score || a.factId.localeCompare(b.factId)).slice(0, Math.max(0, topK));
  };

  const toData: IRtkVectorIndex['toData'] = () => ({
    version: RTK_VECTOR_INDEX_VERSION,
    providerId: embedder.providerId,
    model: embedder.model,
    dimensions,
    entries: [...entries.values()],
  });

  return { upsert, remove, query, toData };
};
