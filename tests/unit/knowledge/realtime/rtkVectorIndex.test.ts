/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createRtkVectorIndex,
  fingerprintText,
  normalizeVector,
  type Embedder,
} from '@/process/knowledge/realtime/rtkVectorIndex';

/** Deterministic bag-of-words embedder over a tiny fixed vocabulary. */
const VOCAB = ['node', 'python', 'price', 'ceo', 'version'];
const makeEmbedder = (spy?: () => void): Embedder => ({
  providerId: 'test',
  model: 'bow',
  embed: (texts) => {
    spy?.();
    return Promise.resolve(
      texts.map((text) => {
        const lower = text.toLowerCase();
        return VOCAB.map((word) => (lower.includes(word) ? 1 : 0));
      })
    );
  },
});

describe('rtkVectorIndex helpers', () => {
  it('normalizeVector makes a unit vector (or zero)', () => {
    const n = normalizeVector([3, 4]);
    expect(Math.hypot(n[0], n[1])).toBeCloseTo(1, 6);
    expect(normalizeVector([0, 0])).toEqual([0, 0]);
  });

  it('fingerprintText is stable and differs by content', () => {
    expect(fingerprintText('abc')).toBe(fingerprintText('abc'));
    expect(fingerprintText('abc')).not.toBe(fingerprintText('abd'));
  });
});

describe('createRtkVectorIndex', () => {
  it('ranks the semantically closest fact first', async () => {
    const index = createRtkVectorIndex(makeEmbedder());
    await index.upsert('node-fact', 'latest node version');
    await index.upsert('python-fact', 'latest python version');
    await index.upsert('ceo-fact', 'current ceo');

    const hits = await index.query('what node version', 3);
    expect(hits[0]?.factId).toBe('node-fact');
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it('skips re-embedding unchanged text (fingerprint match)', async () => {
    const spy = vi.fn();
    const index = createRtkVectorIndex(makeEmbedder(spy));
    await index.upsert('a', 'node version'); // embed #1
    await index.upsert('a', 'node version'); // unchanged → skipped
    expect(spy).toHaveBeenCalledTimes(1);
    await index.upsert('a', 'python version'); // changed → embed #2
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('remove drops a vector and returns whether it existed', async () => {
    const index = createRtkVectorIndex(makeEmbedder());
    await index.upsert('a', 'node version');
    expect(index.remove('a')).toBe(true);
    expect(index.remove('a')).toBe(false);
    expect(await index.query('node', 5)).toEqual([]);
  });

  it('serialises via toData and rehydrates, reusing entries for the same model', async () => {
    const index = createRtkVectorIndex(makeEmbedder());
    await index.upsert('a', 'node version');
    const data = index.toData();
    expect(data.entries).toHaveLength(1);

    const spy = vi.fn();
    const rebuilt = createRtkVectorIndex(makeEmbedder(spy), data);
    await rebuilt.upsert('a', 'node version'); // same fingerprint → no re-embed
    expect(spy).not.toHaveBeenCalled();
    const hits = await rebuilt.query('node', 1);
    expect(hits[0]?.factId).toBe('a');
  });

  it('starts empty when the persisted model differs', async () => {
    const index = createRtkVectorIndex(makeEmbedder());
    await index.upsert('a', 'node version');
    const data = { ...index.toData(), model: 'different-model' };
    const rebuilt = createRtkVectorIndex(makeEmbedder(), data);
    // 'a' was discarded (model mismatch) → query finds nothing for it yet.
    expect(await rebuilt.query('node', 5)).toEqual([]);
  });
});
