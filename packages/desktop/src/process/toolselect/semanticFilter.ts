/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `semanticFilter` — Tier 2 of tool selection (Yêu cầu 7, criterion 7.4): rank
 * catalog entries by meaning, not just keyword overlap, using an embedding model
 * + a local vector store. Indexing and embedding are heavy, so they go through
 * the ResourceCoordinator under `TaskKind: 'semanticIndex'` (criterion 7.8).
 *
 * This is an ORCHESTRATION layer: the embedding model and the vector store are
 * injected behind interfaces (production wires a small/local model + a local
 * index such as sqlite-vec; tests inject deterministic fakes). The module owns
 * the lease wrapping, cosine ranking and a cache of entry embeddings.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import type { CatalogEntry, ScoredEntry } from './catalogTypes';
import type { Lease, LeaseRequest } from '../resource/leaseTypes';

/** Embeds text into a dense vector. Injected (small/local model in production). */
export type Embedder = {
  /** Embed a batch of texts, returning one vector per input (same order). */
  embed(texts: string[]): Promise<number[][]>;
};

/** Minimal lease surface (the real ResourceCoordinator satisfies it). */
export type LeaseCoordinator = {
  requestLease: (req: LeaseRequest) => Promise<Lease>;
  releaseLease: (id: string) => void;
};

/** Options for {@link createSemanticFilter}. */
export type SemanticFilterDeps = {
  /** The embedding model. */
  embedder: Embedder;
  /** Lease gate for index/embed work (criterion 7.8). */
  coordinator: LeaseCoordinator;
  /** Estimated RAM (MB) charged while embedding/indexing. Defaults to 512. */
  estCostMB?: number;
};

/** Public contract of the semantic filter. */
export type ISemanticFilter = {
  /** Build (or rebuild) the vector index for the given catalog entries. */
  index(entries: readonly CatalogEntry[]): Promise<void>;
  /** Rank the indexed entries by semantic similarity to `request`. */
  rank(request: string, limit?: number): Promise<ScoredEntry[]>;
};

/** Default estimated RAM cost (MB) for an embed/index step. */
const DEFAULT_EST_COST_MB = 512;

/** The text that represents an entry for embedding (name + description + keywords). */
const entryText = (entry: CatalogEntry): string =>
  [entry.name, entry.description, ...(entry.keywords ?? [])].join('. ');

/** Cosine similarity between two equal-length vectors (0 when degenerate). */
const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

/**
 * Create a {@link ISemanticFilter} backed by an injected embedder + lease gate.
 *
 * @param deps Embedder, coordinator and tunables. See {@link SemanticFilterDeps}.
 * @returns A semantic filter that indexes a catalog and ranks by meaning.
 */
export const createSemanticFilter = (deps: SemanticFilterDeps): ISemanticFilter => {
  const { embedder, coordinator } = deps;
  const estCostMB = deps.estCostMB ?? DEFAULT_EST_COST_MB;

  /** Cached per-entry embeddings, keyed by entry id. */
  let indexed: { entry: CatalogEntry; vector: number[] }[] = [];

  /** Run a heavy embed step under a `semanticIndex` lease (criterion 7.8). */
  const underLease = async <T>(work: () => Promise<T>): Promise<T> => {
    const lease = await coordinator.requestLease({ kind: 'semanticIndex', estCostMB });
    try {
      return await work();
    } finally {
      coordinator.releaseLease(lease.id);
    }
  };

  const index: ISemanticFilter['index'] = async (entries) => {
    if (entries.length === 0) {
      indexed = [];
      return;
    }
    const vectors = await underLease(() => embedder.embed(entries.map(entryText)));
    indexed = entries.map((entry, i) => ({ entry, vector: vectors[i] ?? [] }));
  };

  const rank: ISemanticFilter['rank'] = async (request, limit = 10) => {
    if (indexed.length === 0) return [];
    const [queryVector] = await underLease(() => embedder.embed([request]));
    if (!queryVector) return [];
    const scored: ScoredEntry[] = indexed.map(({ entry, vector }) => ({
      entry,
      score: cosine(queryVector, vector),
      reason: 'semantic similarity',
    }));
    scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
    return scored.slice(0, limit);
  };

  return { index, rank };
};
