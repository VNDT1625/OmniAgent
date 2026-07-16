/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/manager/webSearch — keyless web search with safe
 * degradation (Requirement 5.11). Injected fetch, no real network.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@/process/manager/webSearch';
import { searchWeb } from '@/process/manager/webSearch';

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('searchWeb', () => {
  it('combines Wikipedia + DuckDuckGo results and de-dupes by URL', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url: string) => {
      if (url.includes('wikipedia.org')) {
        return okJson({
          title: 'Memory',
          extract: 'Memory is...',
          content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Memory' } },
        });
      }
      // DuckDuckGo
      return okJson({
        Heading: 'Memory',
        AbstractText: 'The faculty of the brain...',
        AbstractURL: 'https://duckduckgo.com/Memory',
        RelatedTopics: [
          { Text: 'Spaced repetition - a technique', FirstURL: 'https://duckduckgo.com/Spaced_repetition' },
        ],
      });
    });

    const results = await searchWeb('memory', { fetchImpl });
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.some((r) => r.url.includes('wikipedia'))).toBe(true);
    // No duplicate URLs.
    const urls = results.map((r) => r.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('returns [] for blank query without calling fetch', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    expect(await searchWeb('   ', { fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns [] when everything fails (offline)', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new Error('offline');
    });
    expect(await searchWeb('memory', { fetchImpl })).toEqual([]);
  });

  it('respects the limit', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url: string) => {
      if (url.includes('wikipedia.org')) return { ok: false, status: 404, json: async () => ({}) };
      return okJson({
        RelatedTopics: Array.from({ length: 20 }, (_, i) => ({ Text: `Topic ${i}`, FirstURL: `https://x/${i}` })),
      });
    });
    const results = await searchWeb('many', { fetchImpl, limit: 3 });
    expect(results).toHaveLength(3);
  });
});
