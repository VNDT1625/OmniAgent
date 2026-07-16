/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { scoreSentiment, computeNewsAlerts, aggregateSymbolSentiment } from '@process/news/bots/newsBot';
import type { NewsItem } from '@process/news/newsTypes';
import type { NewsBotConfig } from '@process/news/bots/botTypes';

const item = (over: Partial<NewsItem>): NewsItem => ({
  id: 'i1',
  feedId: 'f1',
  title: 'title',
  link: 'https://e.com',
  summary: '',
  author: null,
  imageUrl: null,
  publishedAt: 1000,
  category: 'business',
  categorySource: 'default',
  rawTags: [],
  read: false,
  fetchedAt: 1000,
  ...over,
});

describe('scoreSentiment', () => {
  it('is positive for bullish text, negative for bearish', () => {
    expect(scoreSentiment('Stock surges to record profit on strong growth')).toBeGreaterThan(0);
    expect(scoreSentiment('Shares plunge on lawsuit and downgrade')).toBeLessThan(0);
  });

  it('handles negation', () => {
    expect(scoreSentiment('did not beat expectations')).toBeLessThanOrEqual(0);
  });

  it('is zero with no lexicon hits', () => {
    expect(scoreSentiment('the company held a meeting today')).toBe(0);
  });
});

describe('computeNewsAlerts', () => {
  const cfg: NewsBotConfig = {
    id: 'n',
    kind: 'news',
    enabled: true,
    watchKeywords: ['nvidia'],
    alertThreshold: 0.2,
    maxAlerts: 10,
  };

  it('alerts on keyword + strong sentiment', () => {
    const items = [item({ id: 'a', title: 'Nvidia profit surges to record on strong demand' })];
    const alerts = computeNewsAlerts(items, cfg, (i) => `alert-${i.id}`);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].matchedKeywords).toContain('nvidia');
    expect(alerts[0].sentiment).toBeGreaterThan(0);
  });

  it('skips items not matching the watch keywords', () => {
    const items = [item({ id: 'b', title: 'Apple profit surges to record' })];
    expect(computeNewsAlerts(items, cfg, (i) => i.id)).toHaveLength(0);
  });

  it('alerts on multi-source corroboration even when neutral', () => {
    const cfgAll: NewsBotConfig = { ...cfg, watchKeywords: [] };
    const items = [
      item({ id: 'x1', feedId: 'f1', title: 'Company announces new data center' }),
      item({ id: 'x2', feedId: 'f2', title: 'Company announces new data center' }),
    ];
    const alerts = computeNewsAlerts(items, cfgAll, (i) => i.id);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].sourceCount).toBe(2);
  });
});

describe('aggregateSymbolSentiment', () => {
  it('averages sentiment of items mentioning each ticker', () => {
    const items = [
      item({ title: 'Apple iPhone demand surges, profit record' }),
      item({ title: 'Tesla recall and lawsuit weigh on shares' }),
    ];
    const agg = aggregateSymbolSentiment(items, { AAPL: ['apple', 'iphone'], TSLA: ['tesla'] });
    expect(agg.AAPL).toBeGreaterThan(0);
    expect(agg.TSLA).toBeLessThan(0);
  });
});
