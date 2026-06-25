/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server-side (Main-process) YouTube transcript fetcher — the "backend" path
 * that makes transcript extraction fast and reliable, the way Comet / yt-dlp /
 * youtube-transcript-api do it.
 *
 * ## Why this beats the in-page approach
 *
 * Fetching captions from INSIDE the watched page runs in the user's logged-in
 * YouTube session, which is gated hard by 2025 anti-bot (PO token / BotGuard) —
 * `get_transcript` returns HTTP 400 and `timedtext` returns an empty 200. An
 * **anonymous, clean-session request from Node** behaves like a fresh visitor:
 * the watch page hands back caption `baseUrl`s that are signed for ANONYMOUS
 * access and generally work WITHOUT a PO token. Node also has no CORS limits and
 * full control of request headers (User-Agent / Accept-Language), so it can look
 * exactly like a desktop browser's first page load.
 *
 * ## Strategy (in order, first success wins)
 *
 * 1. **Watch page → player response → timedtext.** GET the watch HTML anonymously,
 *    extract `ytInitialPlayerResponse`, read its caption tracks, fetch the chosen
 *    track's `baseUrl` (JSON3, then XML). This is yt-dlp's primary subtitle path.
 * 2. **InnerTube player (ANDROID client) → timedtext.** If the HTML had no caption
 *    tracks (common when YouTube ships a stripped initial response), POST to
 *    `youtubei/v1/player` with the ANDROID client context — which is far less
 *    gated — using the page's `INNERTUBE_API_KEY`, then fetch the track.
 *
 * ## Process boundary & testability
 *
 * Main-process (Node.js) module — NO DOM APIs. The only side effect is HTTP, via
 * an injected {@link FetchLike} (defaults to the global `fetch`), so unit tests
 * drive the whole strategy with a scripted fake and assert routing/parsing
 * without touching the network. Mirrors the DI + factory style of the sibling
 * `research/*` modules.
 */

// ---------------------------------------------------------------------------
// Injected collaborator
// ---------------------------------------------------------------------------

/** Minimal structural subset of `fetch` this module needs (injectable for tests). */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

// ---------------------------------------------------------------------------
// Public data model
// ---------------------------------------------------------------------------

/** A successfully fetched transcript. */
export type TranscriptOk = {
  /** Whether a transcript was found. */
  ok: true;
  /** The joined transcript text (plain, whitespace-collapsed). */
  text: string;
  /** BCP-47 language code of the track used (e.g. `en`, `vi`). */
  lang: string;
  /** Which strategy produced it. */
  via: 'watch-timedtext' | 'innertube-timedtext';
};

/** A failed transcript fetch, carrying a short diagnostic reason. */
export type TranscriptFail = {
  /** Whether a transcript was found. */
  ok: false;
  /** Short, joined diagnostic of every attempt (for logs / the agent observation). */
  reason: string;
};

/** Result of {@link IYoutubeTranscript.fetchTranscript}. */
export type TranscriptOutcome = TranscriptOk | TranscriptFail;

/** Public contract of the server-side transcript fetcher. */
export type IYoutubeTranscript = {
  /**
   * Fetch the transcript for a YouTube video URL or id. Resolves with
   * {@link TranscriptOk} on success or {@link TranscriptFail} otherwise; never
   * rejects, so callers can fall back cleanly.
   */
  fetchTranscript(urlOrId: string): Promise<TranscriptOutcome>;
};

/** Dependencies and tunables for {@link createYoutubeTranscript}. */
export type YoutubeTranscriptDeps = {
  /** HTTP client. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Preferred caption languages, most-preferred first. Defaults to `['vi', 'en']`. */
  preferLangs?: string[];
  /** Max characters of transcript returned. Defaults to 100000. */
  maxChars?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A realistic desktop-Chrome User-Agent so YouTube serves the full watch page. */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Browser-like default headers for the anonymous watch-page request. */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': DESKTOP_UA,
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/** Publicly-known InnerTube key (extracted from the page when available). */
const DEFAULT_INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

/** ANDROID InnerTube client context — far less gated than the web client. */
const ANDROID_CONTEXT = {
  client: {
    clientName: 'ANDROID',
    clientVersion: '19.09.37',
    androidSdkVersion: 30,
    hl: 'en',
    gl: 'US',
  },
};

const DEFAULT_PREFER_LANGS = ['vi', 'en'];
const DEFAULT_MAX_CHARS = 100000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Extract the 11-char video id from a watch URL, short URL, shorts URL, embed
 * URL, or a bare id. Returns '' when nothing id-like is found.
 */
export const extractVideoId = (urlOrId: string): string => {
  const raw = urlOrId.trim();
  if (/^[\w-]{11}$/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const parts = u.pathname.split('/').filter(Boolean);
    const shortsIdx = parts.indexOf('shorts');
    if (shortsIdx !== -1 && parts[shortsIdx + 1]) return parts[shortsIdx + 1].slice(0, 11);
    const embedIdx = parts.indexOf('embed');
    if (embedIdx !== -1 && parts[embedIdx + 1]) return parts[embedIdx + 1].slice(0, 11);
    if (u.hostname.includes('youtu.be') && parts[0]) return parts[0].slice(0, 11);
  } catch {
    // not a URL
  }
  return '';
};

/** Collapse whitespace and trim. */
const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Decode the handful of XML/HTML entities that appear in timedtext payloads. */
const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));

/** Parse a timedtext JSON3 body into plain text. Returns '' when empty/invalid. */
export const parseTimedtextJson3 = (body: string): string => {
  try {
    const data = JSON.parse(body) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
    const text = (data.events ?? []).map((e) => (e.segs ?? []).map((s) => s.utf8 ?? '').join('')).join(' ');
    return clean(text);
  } catch {
    return '';
  }
};

/** Parse a timedtext XML body (`<text>` nodes) into plain text. Returns '' when empty. */
export const parseTimedtextXml = (body: string): string => {
  const matches = [...body.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
  if (matches.length === 0) return '';
  return clean(matches.map((m) => decodeEntities(m[1])).join(' '));
};

/**
 * Extract the first balanced JSON object that follows a `marker` in `html`
 * (e.g. `ytInitialPlayerResponse =`). Returns the parsed object or null.
 */
export const extractJsonAfter = (html: string, marker: string): unknown => {
  const at = html.indexOf(marker);
  if (at === -1) return null;
  const start = html.indexOf('{', at);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};

/** A caption track as it appears in a player response. */
type CaptionTrack = { baseUrl?: string; languageCode?: string; kind?: string };

/** Read caption tracks out of a player-response object (any shape). */
const captionTracksOf = (playerResponse: unknown): CaptionTrack[] => {
  const pr = playerResponse as
    | { captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } } }
    | null
    | undefined;
  return pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
};

/** Order tracks by language preference (preferred first), then manual before ASR. */
export const orderTracks = (tracks: CaptionTrack[], preferLangs: string[]): CaptionTrack[] => {
  const score = (t: CaptionTrack): number => {
    const lang = (t.languageCode ?? '').toLowerCase();
    const langIdx = preferLangs.findIndex((p) => lang.startsWith(p.toLowerCase()));
    const langScore = langIdx === -1 ? preferLangs.length : langIdx;
    const asrPenalty = t.kind === 'asr' ? 0.5 : 0; // prefer human captions
    return langScore + asrPenalty;
  };
  return [...tracks].toSorted((a, b) => score(a) - score(b));
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an {@link IYoutubeTranscript} backed by an injected {@link FetchLike}.
 *
 * @param deps HTTP client + language/length tunables. See {@link YoutubeTranscriptDeps}.
 * @returns A ready-to-use server-side transcript fetcher.
 */
export const createYoutubeTranscript = (deps: YoutubeTranscriptDeps = {}): IYoutubeTranscript => {
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
  const preferLangs = deps.preferLangs ?? DEFAULT_PREFER_LANGS;
  const maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;

  /** Fetch one caption track's text, trying JSON3 then XML. '' when both empty. */
  const fetchTrackText = async (baseUrl: string, tried: string[]): Promise<string> => {
    const stripFmt = baseUrl.replace(/&fmt=[^&]*/g, '');
    for (const suffix of ['&fmt=json3', '']) {
      try {
        const res = await doFetch(stripFmt + suffix, {
          headers: { 'User-Agent': DESKTOP_UA, 'Accept-Language': 'en-US,en;q=0.9' },
        });
        if (!res.ok) {
          tried.push(`track ${res.status}`);
          continue;
        }
        const body = await res.text();
        if (!body) {
          tried.push('track empty');
          continue;
        }
        const text = suffix ? parseTimedtextJson3(body) : parseTimedtextXml(body);
        if (text) return text;
      } catch (e) {
        tried.push('track err ' + (e instanceof Error ? e.message : String(e)));
      }
    }
    return '';
  };

  /** Try the ordered tracks; return the first non-empty {text, lang}. */
  const tryTracks = async (tracks: CaptionTrack[], tried: string[]): Promise<{ text: string; lang: string } | null> => {
    for (const track of orderTracks(tracks, preferLangs)) {
      if (!track.baseUrl) continue;
      const text = await fetchTrackText(track.baseUrl, tried);
      if (text) return { text: text.slice(0, maxChars), lang: track.languageCode ?? '?' };
    }
    return null;
  };

  /** Strategy 1: anonymous watch page → player response → timedtext. */
  const fromWatchPage = async (
    videoId: string,
    tried: string[]
  ): Promise<{ result: { text: string; lang: string } | null; apiKey: string }> => {
    let apiKey = DEFAULT_INNERTUBE_KEY;
    try {
      const res = await doFetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, { headers: BROWSER_HEADERS });
      if (!res.ok) {
        tried.push(`watch ${res.status}`);
        return { result: null, apiKey };
      }
      const html = await res.text();
      const keyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
      if (keyMatch) apiKey = keyMatch[1];
      const pr = extractJsonAfter(html, 'ytInitialPlayerResponse');
      const tracks = captionTracksOf(pr);
      if (tracks.length === 0) {
        tried.push('watch no captionTracks');
        return { result: null, apiKey };
      }
      const result = await tryTracks(tracks, tried);
      if (!result) tried.push(`watch ${tracks.length} track(s) all empty`);
      return { result, apiKey };
    } catch (e) {
      tried.push('watch err ' + (e instanceof Error ? e.message : String(e)));
      return { result: null, apiKey };
    }
  };

  /** Strategy 2: InnerTube player with the ANDROID client (less gated). */
  const fromInnerTube = async (
    videoId: string,
    apiKey: string,
    tried: string[]
  ): Promise<{ text: string; lang: string } | null> => {
    try {
      const res = await doFetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': DESKTOP_UA },
        body: JSON.stringify({ context: ANDROID_CONTEXT, videoId }),
      });
      if (!res.ok) {
        tried.push(`innertube ${res.status}`);
        return null;
      }
      const pr = JSON.parse(await res.text()) as unknown;
      const tracks = captionTracksOf(pr);
      if (tracks.length === 0) {
        tried.push('innertube no captionTracks');
        return null;
      }
      const result = await tryTracks(tracks, tried);
      if (!result) tried.push(`innertube ${tracks.length} track(s) all empty`);
      return result;
    } catch (e) {
      tried.push('innertube err ' + (e instanceof Error ? e.message : String(e)));
      return null;
    }
  };

  const fetchTranscript = async (urlOrId: string): Promise<TranscriptOutcome> => {
    const videoId = extractVideoId(urlOrId);
    if (!videoId) return { ok: false, reason: 'not a YouTube video id/url' };
    const tried: string[] = [];

    const watch = await fromWatchPage(videoId, tried);
    if (watch.result) {
      return { ok: true, text: watch.result.text, lang: watch.result.lang, via: 'watch-timedtext' };
    }

    const inner = await fromInnerTube(videoId, watch.apiKey, tried);
    if (inner) {
      return { ok: true, text: inner.text, lang: inner.lang, via: 'innertube-timedtext' };
    }

    return { ok: false, reason: tried.join('; ') || 'no source' };
  };

  return { fetchTranscript };
};
