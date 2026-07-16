/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { computeTrending, keywordsOf } from '@renderer/pages/news/trending';
import type { NewsItem } from '@process/news/newsTypes';

let seq = 0;
const item = (over: Partial<NewsItem>): NewsItem => ({
  id: `i${seq++}`,
  feedId: 'feedA',
  title: 'Untitled',
  link: 'https://e.com/x',
  summary: '',
  author: null,
  imageUrl: null,
  publishedAt: 1_000_000,
  category: 'general',
  categorySource: 'default',
  rawTags: [],
  read: false,
  fetchedAt: 1_000_000,
  ...over,
});

describe('trending — keyword extraction', () => {
  it('drops stopwords and short tokens', () => {
    const kw = keywordsOf('The new economy of Vietnam will grow');
    expect(kw.has('the')).toBe(false); // stopword
    expect(kw.has('new')).toBe(false); // stopword
    expect(kw.has('economy')).toBe(true);
    expect(kw.has('vietnam')).toBe(true);
    expect(kw.has('grow')).toBe(true);
  });

  it('is diacritic-insensitive for Vietnamese', () => {
    const kw = keywordsOf('Chứng khoán Việt Nam tăng điểm');
    expect(kw.has('chung')).toBe(true);
    expect(kw.has('khoan')).toBe(true);
  });
});

describe('trending — multi-source detection (real trend)', () => {
  it('ranks a story covered by multiple feeds above single-source items', () => {
    const items: NewsItem[] = [
      // Same story from 3 different feeds → strong trend.
      item({ feedId: 'vnexpress', title: 'Vietnam stock market surges to record high', publishedAt: 5 }),
      item({ feedId: 'tuoitre', title: 'Stock market in Vietnam surges, hits record', publishedAt: 6 }),
      item({ feedId: 'cafef', title: 'Vietnam stock market record surge today', publishedAt: 7 }),
      // Unrelated single-source items.
      item({ feedId: 'bbc', title: 'Football club signs new striker', publishedAt: 8 }),
      item({ feedId: 'cnn', title: 'New movie breaks box office', publishedAt: 9 }),
    ];
    const { entries, isRealTrend } = computeTrending(items, 5);
    expect(isRealTrend).toBe(true);
    // The 3-feed cluster wins the top spot with sourceCount 3.
    expect(entries[0].sourceCount).toBe(3);
    expect(entries[0].item.title.toLowerCase()).toContain('stock');
  });

  it('does not inflate source count for repeats from the same feed', () => {
    const items: NewsItem[] = [
      item({ feedId: 'vnexpress', title: 'Typhoon hits central coast hard', publishedAt: 5 }),
      item({ feedId: 'vnexpress', title: 'Typhoon central coast hard damage', publishedAt: 6 }),
    ];
    const { isRealTrend } = computeTrending(items, 5);
    // Two articles but the SAME feed → not a cross-source trend.
    expect(isRealTrend).toBe(false);
  });

  it('falls back to latest (isRealTrend=false) when nothing is multi-source', () => {
    const items: NewsItem[] = [
      item({ feedId: 'a', title: 'Alpha unrelated story one', publishedAt: 1 }),
      item({ feedId: 'b', title: 'Beta different topic entirely', publishedAt: 3 }),
      item({ feedId: 'c', title: 'Gamma another separate headline', publishedAt: 2 }),
    ];
    const { entries, isRealTrend } = computeTrending(items, 5);
    expect(isRealTrend).toBe(false);
    // Latest first.
    expect(entries[0].item.title).toContain('Beta');
    expect(entries.every((e) => e.sourceCount === 1)).toBe(true);
  });
});
