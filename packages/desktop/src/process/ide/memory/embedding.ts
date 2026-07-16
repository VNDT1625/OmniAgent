/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Local, dependency-free text embedder for IDE session-memory semantic recall.
 *
 * ## Why a hand-rolled embedder (not a transformer model)
 *
 * The session super-memory is designed to be FAST, OFFLINE, and zero-dependency
 * (no model download, no network, no native binary). A learned transformer
 * embedder (e.g. MiniLM via transformers.js) would download weights on first use
 * and add latency + bundle size — at odds with that design. So this module
 * implements a deterministic **feature-hashing bag-of-n-grams** vector instead:
 *
 * - Each note is turned into a fixed-dimension vector by hashing its word tokens
 *   AND their character 3-grams into buckets (the "hashing trick"), with a signed
 *   hash so inner products stay unbiased.
 * - The vector is L2-normalised, so cosine similarity is a plain dot product.
 *
 * This is a *lexical-semantic* vector: it captures sub-word similarity — "auth"
 * ranks close to "authentication", "redis cache" close to "caching with redis",
 * and typos/morphological variants still match — which pure token-overlap misses.
 * It does NOT learn true synonyms ("cache" ≠ "store"); for that a model embedder
 * can be injected through the same {@link SuperMemoryEmbedder} interface.
 *
 * Pure module: deterministic, no side effects, unit-testable, no Node/DOM APIs.
 */

/** A text → vector embedder. Injected so a model-backed one can replace the default. */
export type SuperMemoryEmbedder = {
  /** Embed `text` into a fixed-length, L2-normalised vector. */
  embed: (text: string) => number[];
  /** The vector dimension (so callers can size buffers / validate). */
  readonly dim: number;
};

/** Default vector dimension — large enough to keep hash collisions low, small enough to stay cheap. */
const DEFAULT_DIM = 256;
/** Character n-gram size used for sub-word features. */
const NGRAM = 3;

/** FNV-1a 32-bit hash of a string (matches the repo's graph-fingerprint hash family). */
const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (avoids BigInt; keeps it fast).
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
};

/** Tokenise text into lowercase word tokens (letters/numbers across scripts). */
const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);

/** Add a hashed feature into the vector with a sign drawn from a second hash bit. */
const addFeature = (vec: number[], feature: string, weight: number, dim: number): void => {
  const h = fnv1a(feature);
  const bucket = h % dim;
  const sign = (fnv1a(`#${feature}`) & 1) === 0 ? 1 : -1;
  vec[bucket] += weight * sign;
};

/**
 * Create a deterministic local embedder. Word tokens carry a strong weight; their
 * padded character 3-grams carry a lighter weight so sub-word overlap contributes
 * to similarity without dominating.
 *
 * @param dim Vector dimension (default {@link DEFAULT_DIM}).
 * @returns A {@link SuperMemoryEmbedder}.
 */
export const createLocalEmbedder = (dim: number = DEFAULT_DIM): SuperMemoryEmbedder => ({
  dim,
  embed: (text: string): number[] => {
    const vec = Array.from<number>({ length: dim }).fill(0);
    const tokens = tokenize(text);
    for (const token of tokens) {
      addFeature(vec, token, 1, dim); // whole-token feature (strong)
      const padded = `^${token}$`;
      for (let i = 0; i + NGRAM <= padded.length; i++) {
        addFeature(vec, padded.slice(i, i + NGRAM), 0.5, dim); // sub-word n-gram (light)
      }
    }
    // L2-normalise so cosine similarity reduces to a dot product.
    let norm = 0;
    for (const value of vec) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dim; i++) vec[i] /= norm;
    }
    return vec;
  },
});

/**
 * Cosine similarity of two vectors (0..1 for these non-negative-leaning hashed
 * vectors; can be slightly negative due to signed hashing). Robust to non-unit
 * vectors by dividing by norms; for already-normalised vectors this is the dot
 * product.
 */
export const cosineSimilarity = (a: number[], b: number[]): number => {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};
