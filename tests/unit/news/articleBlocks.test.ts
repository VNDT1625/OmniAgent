/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { buildBlocks } from '@renderer/pages/news/components/ArticleList';
import type { NewsItem } from '@process/news/newsTypes';

const mk = (n: number): NewsItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `id${i}`,
    feedId: 'f',
    title: `Title ${i}`,
    link: `https://e.com/${i}`,
    summary: '',
    author: null,
    imageUrl: null,
    publishedAt: 1000 - i,
    category: 'general',
    categorySource: 'default',
    rawTags: [],
    read: false,
    fetchedAt: 1000,
  }));

describe('buildBlocks — count preservation', () => {
  // Every rendered card must map to exactly one input item — no drops.
  for (const n of [1, 2, 3, 5, 13, 19, 20, 21, 40]) {
    it(`keeps all ${n} items across blocks`, () => {
      const blocks = buildBlocks(mk(n));
      const total = blocks.reduce((sum, b) => sum + b.items.length, 0);
      expect(total).toBe(n);
      // Also assert no item id is lost or duplicated.
      const ids = blocks.flatMap((b) => b.items.map((it) => it.id));
      expect(new Set(ids).size).toBe(n);
    });
  }
});
