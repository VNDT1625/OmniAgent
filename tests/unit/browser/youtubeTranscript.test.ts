/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/browser/research/youtubeTranscript — the server-side
 * (Main-process) transcript fetcher. A scripted fake `fetch` drives the whole
 * strategy with no network: id extraction, watch-page → timedtext, the
 * InnerTube ANDROID fallback when the watch HTML has no caption tracks, JSON3 +
 * XML parsing, language preference, and the failure path.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createYoutubeTranscript,
  extractVideoId,
  extractJsonAfter,
  orderTracks,
  parseTimedtextJson3,
  parseTimedtextXml,
  type FetchLike,
} from '@/process/browser/research/youtubeTranscript';

// ---------------------------------------------------------------------------
// Fake fetch — routes by URL substring to a scripted body.
// ---------------------------------------------------------------------------

type Route = { ok?: boolean; status?: number; body: string };

const fakeFetch = (routes: Array<{ match: string; route: Route }>): { fetch: FetchLike; calls: string[] } => {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const hit = routes.find((r) => url.includes(r.match));
    const route = hit?.route ?? { ok: false, status: 404, body: '' };
    return {
      ok: route.ok ?? true,
      status: route.status ?? 200,
      text: async () => route.body,
    };
  };
  return { fetch, calls };
};

/** A watch-page HTML carrying a player response with one caption track. */
const watchHtml = (baseUrl: string, lang = 'en', key = 'KEY123'): string => {
  const pr = {
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl, languageCode: lang, kind: 'asr' }] } },
  };
  return `<!doctype html><script>var ytInitialPlayerResponse = ${JSON.stringify(pr)};</script><script>"INNERTUBE_API_KEY":"${key}"</script>`;
};

const json3 = (...lines: string[]): string => JSON.stringify({ events: lines.map((l) => ({ segs: [{ utf8: l }] })) });

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('extractVideoId', () => {
  it('reads ?v=, youtu.be, shorts, embed, and bare ids', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=abcdEFGH123')).toBe('abcdEFGH123');
    expect(extractVideoId('https://youtu.be/abcdEFGH123')).toBe('abcdEFGH123');
    expect(extractVideoId('https://www.youtube.com/shorts/abcdEFGH123')).toBe('abcdEFGH123');
    expect(extractVideoId('https://www.youtube.com/embed/abcdEFGH123')).toBe('abcdEFGH123');
    expect(extractVideoId('abcdEFGH123')).toBe('abcdEFGH123');
    expect(extractVideoId('https://example.com/no-id')).toBe('');
  });
});

describe('timedtext parsers', () => {
  it('parses JSON3 events into joined text', () => {
    expect(parseTimedtextJson3(json3('hello', 'world'))).toBe('hello world');
    expect(parseTimedtextJson3('not json')).toBe('');
  });

  it('parses XML <text> nodes and decodes entities', () => {
    const xml =
      '<transcript><text start="0">Tom &amp; Jerry</text><text start="1">say &quot;hi&quot;</text></transcript>';
    expect(parseTimedtextXml(xml)).toBe('Tom & Jerry say "hi"');
    expect(parseTimedtextXml('<none/>')).toBe('');
  });
});

describe('extractJsonAfter', () => {
  it('extracts the first balanced object after a marker, ignoring braces in strings', () => {
    const html = 'x = {"a":"}{","b":{"c":1}} ; rest';
    expect(extractJsonAfter(html, 'x =')).toEqual({ a: '}{', b: { c: 1 } });
  });

  it('returns null when the marker is absent', () => {
    expect(extractJsonAfter('nothing here', 'ytInitialPlayerResponse')).toBeNull();
  });
});

describe('orderTracks', () => {
  it('orders by language preference, manual before ASR', () => {
    const tracks = [
      { baseUrl: 'a', languageCode: 'en', kind: 'asr' },
      { baseUrl: 'b', languageCode: 'vi' },
      { baseUrl: 'c', languageCode: 'fr' },
    ];
    const ordered = orderTracks(tracks, ['vi', 'en']);
    expect(ordered[0].languageCode).toBe('vi');
    expect(ordered[1].languageCode).toBe('en');
  });
});

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

describe('createYoutubeTranscript', () => {
  it('rejects a non-YouTube input without fetching', async () => {
    const { fetch, calls } = fakeFetch([]);
    const yt = createYoutubeTranscript({ fetch });
    const out = await yt.fetchTranscript('https://example.com/x');
    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('strategy 1: watch page → timedtext (JSON3) succeeds', async () => {
    const { fetch, calls } = fakeFetch([
      { match: '/watch?v=', route: { body: watchHtml('https://yt.com/api/timedtext?v=abcdEFGH123&lang=en') } },
      { match: '/api/timedtext', route: { body: json3('first line', 'second line') } },
    ]);
    const yt = createYoutubeTranscript({ fetch });
    const out = await yt.fetchTranscript('https://www.youtube.com/watch?v=abcdEFGH123');

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toBe('first line second line');
      expect(out.via).toBe('watch-timedtext');
    }
    // First call is the watch page.
    expect(calls[0]).toContain('/watch?v=abcdEFGH123');
  });

  it('falls back to XML when JSON3 is empty', async () => {
    const { fetch } = fakeFetch([
      { match: '/watch?v=', route: { body: watchHtml('https://yt.com/api/timedtext?v=x') } },
      // json3 (has &fmt=json3) → empty; plain XML (no fmt) → has text
      { match: '&fmt=json3', route: { body: '' } },
      { match: '/api/timedtext', route: { body: '<t><text>xml fallback works</text></t>' } },
    ]);
    const yt = createYoutubeTranscript({ fetch });
    const out = await yt.fetchTranscript('abcdEFGH123');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toBe('xml fallback works');
  });

  it('strategy 2: InnerTube ANDROID fallback when the watch HTML has no caption tracks', async () => {
    const innerPr = JSON.stringify({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: 'https://yt.com/api/timedtext?from=innertube', languageCode: 'en' }],
        },
      },
    });
    const { fetch, calls } = fakeFetch([
      // Watch HTML has a key but NO captionTracks.
      { match: '/watch?v=', route: { body: '<script>"INNERTUBE_API_KEY":"KEYXYZ"</script>' } },
      { match: '/youtubei/v1/player', route: { body: innerPr } },
      { match: '/api/timedtext', route: { body: json3('from innertube') } },
    ]);
    const yt = createYoutubeTranscript({ fetch });
    const out = await yt.fetchTranscript('https://www.youtube.com/watch?v=abcdEFGH123');

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toBe('from innertube');
      expect(out.via).toBe('innertube-timedtext');
    }
    // The InnerTube player call used the key scraped from the watch HTML.
    expect(calls.some((c) => c.includes('/youtubei/v1/player?key=KEYXYZ'))).toBe(true);
  });

  it('returns a diagnostic failure when every source is empty', async () => {
    const { fetch } = fakeFetch([
      { match: '/watch?v=', route: { body: '<script>"INNERTUBE_API_KEY":"K"</script>' } },
      { match: '/youtubei/v1/player', route: { ok: false, status: 400, body: '' } },
    ]);
    const yt = createYoutubeTranscript({ fetch });
    const out = await yt.fetchTranscript('abcdEFGH123');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain('watch no captionTracks');
      expect(out.reason).toContain('innertube 400');
    }
  });

  it('respects language preference across multiple tracks', async () => {
    const pr = JSON.stringify({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: 'https://yt.com/api/timedtext?l=en', languageCode: 'en' },
            { baseUrl: 'https://yt.com/api/timedtext?l=vi', languageCode: 'vi' },
          ],
        },
      },
    });
    const { fetch } = fakeFetch([
      { match: '/watch?v=', route: { body: `<script>var ytInitialPlayerResponse = ${pr};</script>` } },
      { match: 'l=vi', route: { body: json3('tiếng việt') } },
      { match: 'l=en', route: { body: json3('english') } },
    ]);
    const yt = createYoutubeTranscript({ fetch, preferLangs: ['vi', 'en'] });
    const out = await yt.fetchTranscript('abcdEFGH123');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.lang).toBe('vi');
      expect(out.text).toBe('tiếng việt');
    }
  });
});
