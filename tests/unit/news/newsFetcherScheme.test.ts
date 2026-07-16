/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { fetchFeed, validateFeedUrl, isHttpUrl } from '@process/news/newsFetcher';
import type { NewsFeed } from '@process/news/newsTypes';

const feed = (url: string): NewsFeed => ({
  id: 'f',
  url,
  title: url,
  category: null,
  enabled: true,
  createdAt: 0,
  lastFetchedAt: null,
  lastError: null,
});

describe('newsFetcher — URL scheme guard', () => {
  it('isHttpUrl accepts only http/https', () => {
    expect(isHttpUrl('https://e.com/rss')).toBe(true);
    expect(isHttpUrl('http://e.com/rss')).toBe(true);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('ftp://e.com/x')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });

  it('validateFeedUrl rejects non-http(s) without fetching', async () => {
    const fetchMock = vi.fn();
    const res = await validateFeedUrl('file:///etc/passwd', { fetch: fetchMock as unknown as typeof fetch });
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetchFeed rejects non-http(s) without fetching', async () => {
    const fetchMock = vi.fn();
    const res = await fetchFeed(feed('file:///etc/passwd'), [], { fetch: fetchMock as unknown as typeof fetch });
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
