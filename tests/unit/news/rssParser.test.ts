/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseFeed } from '@process/news/rssParser';

describe('rssParser — image extraction', () => {
  it('extracts <img> from a CDATA description (VnExpress style) and decodes &amp;', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>VnExpress</title>
<item>
<title><![CDATA[Tin thử nghiệm]]></title>
<description><![CDATA[<a href="https://vnexpress.net/abc.html"><img src="https://i1-vnexpress.vnecdn.net/2026/06/01/abc.jpg?w=300&amp;h=180&amp;q=100" /></a>Nội dung bài.]]></description>
<pubDate>Tue, 02 Jun 2026 08:00:00 +0700</pubDate>
<link>https://vnexpress.net/abc.html</link>
</item></channel></rss>`;
    const feed = parseFeed(xml);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].imageUrl).toBe('https://i1-vnexpress.vnecdn.net/2026/06/01/abc.jpg?w=300&h=180&q=100');
  });

  it('extracts media:content image', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>T</title>
<item><title>S</title><link>https://e.com/1</link><description>plain</description>
<media:content url="https://e.com/pic.jpg" medium="image" /></item></channel></rss>`;
    expect(parseFeed(xml).items[0].imageUrl).toBe('https://e.com/pic.jpg');
  });

  it('extracts media:thumbnail', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>T</title>
<item><title>S</title><link>https://e.com/1</link>
<media:thumbnail url="https://e.com/thumb.png" /></item></channel></rss>`;
    expect(parseFeed(xml).items[0].imageUrl).toBe('https://e.com/thumb.png');
  });

  it('extracts enclosure image', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>T</title>
<item><title>S</title><link>https://e.com/1</link>
<enclosure url="https://e.com/enc.jpg" type="image/jpeg" length="123" /></item></channel></rss>`;
    expect(parseFeed(xml).items[0].imageUrl).toBe('https://e.com/enc.jpg');
  });

  it('last-resort fallback finds a bare image URL anywhere in the item', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>T</title>
<item><title>S</title><link>https://e.com/1</link>
<customTag>see https://cdn.e.com/photo.webp?v=2 here</customTag></item></channel></rss>`;
    expect(parseFeed(xml).items[0].imageUrl).toBe('https://cdn.e.com/photo.webp?v=2');
  });

  it('returns null when no image is present anywhere', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>T</title>
<item><title>S</title><link>https://e.com/1</link><description>just text, no image</description></item></channel></rss>`;
    expect(parseFeed(xml).items[0].imageUrl).toBeNull();
  });

  it('parses Atom entries with link[@href]', () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Feed</title>
<entry><title>Atom Story</title><link href="https://e.com/atom1" rel="alternate" />
<summary>Summary text</summary><updated>2026-06-02T08:00:00Z</updated></entry></feed>`;
    const feed = parseFeed(xml);
    expect(feed.title).toBe('Atom Feed');
    expect(feed.items[0].link).toBe('https://e.com/atom1');
  });
});
