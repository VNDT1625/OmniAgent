/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the vector math + embedding wrapper of the ExpBase engine.
 */

import { describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  embedNormalized,
  embedOne,
  normalizeVector,
  rankByVector,
  type ExperienceEmbedder,
} from '@/process/experience/experienceVectorIndex';

const fakeEmbedder = (vectors: number[][]): ExperienceEmbedder => ({
  providerId: 'fake',
  model: 'fake-embed',
  embed: async (texts) => texts.map((_, index) => vectors[index] ?? []),
});

describe('normalizeVector', () => {
  it('returns a unit-length vector', () => {
    const out = normalizeVector([3, 4]);
    expect(Math.hypot(...out)).toBeCloseTo(1, 6);
  });

  it('returns zeros for a zero vector', () => {
    expect(normalizeVector([0, 0])).toEqual([0, 0]);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical normalized vectors', () => {
    const v = normalizeVector([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('clamps to [0, 1] for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(0);
  });

  it('returns 0 for empty input', () => {
    expect(cosineSimilarity([], [1, 2])).toBe(0);
  });
});

describe('embedNormalized / embedOne', () => {
  it('normalizes provider output and maps empty vectors to null', async () => {
    const embedder = fakeEmbedder([[3, 4], []]);
    const out = await embedNormalized(embedder, ['a', 'b']);
    expect(Math.hypot(...(out[0] as number[]))).toBeCloseTo(1, 6);
    expect(out[1]).toBeNull();
  });

  it('embedOne returns a single normalized vector', async () => {
    const vector = await embedOne(fakeEmbedder([[0, 5]]), 'x');
    expect(vector).toEqual([0, 1]);
  });

  it('returns [] for empty input', async () => {
    expect(await embedNormalized(fakeEmbedder([]), [])).toEqual([]);
  });
});

describe('rankByVector', () => {
  it('scores candidates by cosine and skips vectorless ones', () => {
    const query = normalizeVector([1, 0]);
    const scores = rankByVector(query, [
      { id: 'same', vector: normalizeVector([1, 0]) },
      { id: 'orthogonal', vector: normalizeVector([0, 1]) },
      { id: 'none' },
    ]);
    expect(scores.get('same')).toBeCloseTo(1, 6);
    expect(scores.get('orthogonal')).toBeCloseTo(0, 6);
    expect(scores.has('none')).toBe(false);
  });

  it('returns empty map for empty query vector', () => {
    expect(rankByVector([], [{ id: 'a', vector: [1] }]).size).toBe(0);
  });
});
