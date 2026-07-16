/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { fetchFeed } from '@process/news/newsFetcher';
import type { NewsFeed } from '@process/news/newsTypes';

const makeFeed = (over: Partial<NewsFeed> = {}): NewsFeed => ({
  id: 'f1',
  url: 'https://example.com/rss',
  title: 'Example',
  category: null,
  enabled: true,
  createdAt: 0,
  lastFetchedAt: null,
  lastError: null,
  ...over,
});

const FEED_WITH_IMAGE = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Ex</title>
<item><title>Has image</title><link>https://example.com/a</link>
<media:content url="https://cdn.example.com/a.jpg" medium="image" /></item></channel></rss>`;

const FEED_NO_IMAGE = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Ex</title>
<item><title>No image</title><link>https://example.com/b</link><description>plain text</description></item>
</channel></rss>`;

const PAGE_WITH_OG = `<!doctype html><html><head>
<meta property="og:title" content="B" />
<meta property="og:image" content="https://cdn.example.com/og-b.jpg" />
</head><body>...</body></html>`;

describe('newsFetcher — og:image enrichment', () => {
  it('keeps the feed image and does not fetch the page when image already present', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/rss')) return new Response(FEED_WITH_IMAGE, { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const res = await fetchFeed(makeFeed(), [], { fetch: fetchMock as unknown as typeof fetch });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items[0].imageUrl).toBe('https://cdn.example.com/a.jpg');
    }
    // Only the feed itself was fetched (no page enrichment needed).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('enriches missing images from the article page og:image', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/rss')) return new Response(FEED_NO_IMAGE, { status: 200 });
      if (url === 'https://example.com/b') return new Response(PAGE_WITH_OG, { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const res = await fetchFeed(makeFeed(), [], { fetch: fetchMock as unknown as typeof fetch });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items[0].imageUrl).toBe('https://cdn.example.com/og-b.jpg');
    }
    // Feed + the one article page.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('leaves imageUrl null when the page has no og:image', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/rss')) return new Response(FEED_NO_IMAGE, { status: 200 });
      return new Response('<html><head><title>x</title></head><body>no og</body></html>', { status: 200 });
    });
    const res = await fetchFeed(makeFeed(), [], { fetch: fetchMock as unknown as typeof fetch });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.items[0].imageUrl).toBeNull();
  });

  it('strips HTML from the summary (no leaked image URLs)', async () => {
    const feedHtmlSummary = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Ex</title>
<item><title>T</title><link>https://example.com/c</link>
<description><![CDATA[<img src="https://x.com/p.jpg"/><p>Real summary text.</p>]]></description>
<media:content xmlns:media="http://search.yahoo.com/mrss/" url="https://x.com/p.jpg" medium="image" /></item>
</channel></rss>`;
    const fetchMock = vi.fn(async () => new Response(feedHtmlSummary, { status: 200 }));
    const res = await fetchFeed(makeFeed(), [], { fetch: fetchMock as unknown as typeof fetch });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items[0].summary).toBe('Real summary text.');
      expect(res.items[0].summary).not.toContain('http');
    }
  });
});
