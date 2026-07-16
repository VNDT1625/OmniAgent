/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the dependency-free local embedder used by IDE session-memory
 * semantic recall. Verifies: deterministic + L2-normalised output, and that
 * sub-word overlap produces meaningful similarity ("auth" ~ "authentication" >
 * "auth" ~ "payment") — the property that lifts recall above pure token overlap.
 */

import { describe, expect, it } from 'vitest';
import { createLocalEmbedder, cosineSimilarity } from '@/process/ide/memory/embedding';

describe('createLocalEmbedder', () => {
  it('produces a deterministic, fixed-dimension, normalised vector', () => {
    const embedder = createLocalEmbedder(128);
    const a = embedder.embed('authentication module');
    const b = embedder.embed('authentication module');
    expect(a).toHaveLength(128);
    expect(a).toEqual(b); // deterministic
    const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5); // L2-normalised
  });

  it('ranks sub-word-related text closer than unrelated text', () => {
    const embedder = createLocalEmbedder();
    const auth = embedder.embed('auth');
    const authentication = embedder.embed('authentication');
    const payment = embedder.embed('payment processing');

    const simRelated = cosineSimilarity(auth, authentication);
    const simUnrelated = cosineSimilarity(auth, payment);
    expect(simRelated).toBeGreaterThan(simUnrelated);
    expect(simRelated).toBeGreaterThan(0.1);
  });

  it('gives identical text a similarity of ~1', () => {
    const embedder = createLocalEmbedder();
    const v = embedder.embed('redis cache with ttl');
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns 0 similarity against an empty embedding', () => {
    const embedder = createLocalEmbedder();
    expect(cosineSimilarity(embedder.embed('x'), embedder.embed(''))).toBe(0);
  });
});
