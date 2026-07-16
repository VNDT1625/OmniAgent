/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Property 10 ("Lọc trước khi nạp" / filter-before-load): the tool selector must
 * NEVER expose the whole catalog — `shortlist`/`select` always return at most the
 * configured top-k candidates, regardless of how large the catalog is or what the
 * request says (Yêu cầu 7, criteria 7.2 / 7.6).
 *
 * fast-check is not a dependency; a deterministic seeded PRNG (mulberry32) drives
 * randomized large catalogs + requests, reporting the seed on failure.
 *
 * Validates: Requirements 7.2, 7.6
 */

import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '@/process/toolselect/catalogTypes';
import type { ICatalog } from '@/process/toolselect/catalog';
import type { ISelectionLog, SelectionLogEntry } from '@/process/toolselect/selectionLog';
import { createToolSelector, type AttemptFn } from '@/process/toolselect/toolSelector';

const PROPERTY_RUNS = 200;

const makeRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const forAllSeeds = async (runs: number, check: (rng: () => number, run: number) => Promise<void>): Promise<void> => {
  for (let run = 0; run < runs; run++) {
    const seed = ((run + 1) * 0x9e3779b1) >>> 0;
    try {
      await check(makeRng(seed), run);
    } catch (error) {
      throw new Error(`Property failed on run ${run} (seed ${seed}): ${(error as Error).message}`, { cause: error });
    }
  }
};

const randInt = (rng: () => number, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));

const WORDS = [
  'web',
  'pdf',
  'excel',
  'slide',
  'audio',
  'video',
  'image',
  'code',
  'data',
  'chart',
  'email',
  'search',
  'translate',
  'summary',
  'agent',
  'browser',
  'file',
  'convert',
  'render',
  'index',
];

const pickWord = (rng: () => number): string => WORDS[randInt(rng, 0, WORDS.length - 1)];

/** Build a large random catalog (criterion 7.2 only matters when the catalog is big). */
const genCatalog = (rng: () => number): CatalogEntry[] => {
  const count = randInt(rng, 30, 200);
  const entries: CatalogEntry[] = [];
  for (let i = 0; i < count; i++) {
    const words = Array.from({ length: randInt(rng, 1, 4) }, () => pickWord(rng));
    entries.push({
      id: `entry:${i}`,
      source: rng() < 0.5 ? 'skill' : 'mcpTool',
      name: `Tool ${i} ${words[0]}`,
      description: `Does ${words.join(' ')} things`,
      keywords: words,
    });
  }
  return entries;
};

const fakeCatalog = (entries: CatalogEntry[]): ICatalog => ({
  refresh: async () => entries,
  list: async () => entries,
  get: async (id) => entries.find((e) => e.id === id),
});

const fakeLog = (): ISelectionLog => {
  const entries: SelectionLogEntry[] = [];
  return {
    hashRequest: (r) => r.trim().toLowerCase(),
    record: async (request, chosen, succeeded) => {
      const e: SelectionLogEntry = {
        requestHash: request.trim().toLowerCase(),
        requestSnippet: request,
        chosen,
        succeeded,
        at: 0,
      };
      entries.unshift(e);
      return e;
    },
    recall: async () => undefined,
    all: async () => entries,
  };
};

describe('Property 10: Lọc trước khi nạp (Requirements 7.2, 7.6)', () => {
  it('shortlist never returns more than top-k, however large the catalog', async () => {
    await forAllSeeds(PROPERTY_RUNS, async (rng) => {
      const entries = genCatalog(rng);
      const topK = randInt(rng, 1, 8);
      const selector = createToolSelector({ catalog: fakeCatalog(entries), selectionLog: fakeLog(), topK });
      const request = Array.from({ length: randInt(rng, 1, 5) }, () => pickWord(rng)).join(' ');

      const shortlist = await selector.shortlist(request);

      // The agent only ever sees the filtered top-k — never the whole catalog.
      expect(shortlist.length).toBeLessThanOrEqual(topK);
      expect(shortlist.length).toBeLessThanOrEqual(entries.length);
      // Every returned candidate is a real catalog entry (no fabrication).
      const ids = new Set(entries.map((e) => e.id));
      expect(shortlist.every((s) => ids.has(s.entry.id))).toBe(true);
    });
  });

  it('select only ever tries candidates from the bounded shortlist (never the whole catalog)', async () => {
    await forAllSeeds(PROPERTY_RUNS, async (rng) => {
      const entries = genCatalog(rng);
      const topK = randInt(rng, 1, 6);
      const maxRounds = randInt(rng, 1, 5);
      const selector = createToolSelector({ catalog: fakeCatalog(entries), selectionLog: fakeLog(), topK, maxRounds });
      const request = Array.from({ length: randInt(rng, 1, 5) }, () => pickWord(rng)).join(' ');

      // Always fail so the loop tries as many candidates as it is allowed to.
      const attempt: AttemptFn = async () => ({ ok: false });
      const result = await selector.select(request, attempt);

      // Tried set is bounded by BOTH the round limit and the shortlist size — and
      // can never exceed top-k (so the agent never enumerates the full catalog).
      expect(result.tried.length).toBeLessThanOrEqual(Math.min(maxRounds, topK));
      expect(result.candidates.length).toBeLessThanOrEqual(topK);
    });
  });
});
