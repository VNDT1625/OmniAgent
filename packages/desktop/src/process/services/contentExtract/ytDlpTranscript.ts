/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * yt-dlp-backed YouTube transcript fetcher — the PRIMARY transcript path.
 *
 * yt-dlp is the most reliable subtitle/caption extractor available. Running on
 * the user's desktop (a residential IP, optionally with their browser cookies)
 * it sidesteps most of the bot/PO-token gating that breaks anonymous in-app
 * fetches. This module shells out to the resolved `yt-dlp` binary to download
 * the best available caption track (manual preferred, else auto-generated),
 * writes it to a temp dir, parses VTT/SRV/JSON3 into plain text, then cleans up.
 *
 * When yt-dlp is not installed, or the video has no captions, the call resolves
 * with `ok:false` (never throws) so the caller can fall back to the next tier.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs. The binary
 * locator and the spawner are injected so the whole flow is unit-testable
 * without yt-dlp or the network.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findExternalTool, envWithToolPaths } from './externalTools';
import type { ExtractOutcome } from './contentExtractTypes';

/** Minimal spawner contract (injectable for tests). Resolves with stdout/exit. */
export type SpawnLike = (
  file: string,
  args: string[],
  options: { timeout?: number; cwd?: string }
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Dependencies and tunables for {@link createYtDlpTranscript}. */
export type YtDlpTranscriptDeps = {
  /** Locate the yt-dlp binary. Defaults to {@link findExternalTool}. Returns null when absent. */
  resolveBinary?: () => Promise<string | null>;
  /** Process spawner. Defaults to a thin `execFile` wrapper. */
  spawn?: SpawnLike;
  /** Make a unique temp dir for the subtitle download. Defaults to `os.tmpdir()` mkdtemp. */
  makeTempDir?: () => Promise<string>;
  /** Preferred caption languages, most-preferred first. Defaults to `['vi', 'en']`. */
  preferLangs?: string[];
  /**
   * Browser to pull cookies from (`--cookies-from-browser`), e.g. `chrome`.
   * Optional — when set, lifts the success rate on gated videos. Defaults to
   * unset (no cookies) since the embedded browser has its own session.
   */
  cookiesFromBrowser?: string;
  /**
   * Write a Netscape-format `cookies.txt` into the given temp dir and return its
   * path (or null to run anonymously). Optional. When provided and it returns a
   * path, yt-dlp authenticates with the user's REAL session via `--cookies`,
   * which lifts YouTube's anonymous rate limit (the HTTP 429 wall) and bypasses
   * most PO-token gating. The file lives inside yt-dlp's per-fetch temp dir, so
   * it is deleted together with the subtitles when the fetch finishes (auth
   * cookies never linger on disk). Best-effort: must not throw.
   */
  getCookieFile?: (dir: string) => Promise<string | null>;
  /** Max characters of transcript returned. Defaults to 100000. */
  maxChars?: number;
};

/** Public contract — mirrors the existing `IYoutubeTranscript`. */
export type IYtDlpTranscript = {
  /** Fetch a transcript for a YouTube URL/id. Never rejects; `ok:false` on miss. */
  fetchTranscript(urlOrId: string): Promise<ExtractOutcome>;
};

const DEFAULT_PREFER_LANGS = ['vi', 'en'];
const DEFAULT_MAX_CHARS = 100000;

/** Default `execFile`-based spawner. */
const defaultSpawn: SpawnLike = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: options.timeout ?? 60000,
        cwd: options.cwd,
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 16,
        // Augment PATH so yt-dlp can find `deno` (its JS-challenge solver) and
        // other user-installed tools the Electron process doesn't inherit.
        env: envWithToolPaths(),
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    );
  });

/** Collapse whitespace and trim. */
const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Parse a WebVTT/SRT caption body into plain text (drop timing + cue numbers). */
export const parseVtt = (body: string): string => {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let lastLine = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line === 'WEBVTT' || line.startsWith('NOTE') || line.startsWith('Kind:') || line.startsWith('Language:'))
      continue;
    if (line.includes('-->')) continue; // timing cue
    if (/^\d+$/.test(line)) continue; // SRT sequence number
    // Strip inline tags (e.g. <c>, <00:00:01.000>) and entities.
    const text = clean(line.replace(/<[^>]+>/g, ''));
    if (!text || text === lastLine) continue; // YouTube VTT repeats rolling lines
    out.push(text);
    lastLine = text;
  }
  return clean(out.join(' '));
};

/** Parse a timedtext JSON3 body into plain text. Returns '' when empty/invalid. */
export const parseJson3 = (body: string): string => {
  try {
    const data = JSON.parse(body) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
    return clean((data.events ?? []).map((e) => (e.segs ?? []).map((s) => s.utf8 ?? '').join('')).join(' '));
  } catch {
    return '';
  }
};

/** Parse a downloaded subtitle file by extension. */
const parseSubtitle = (name: string, body: string): string => {
  if (name.endsWith('.json3') || name.endsWith('.json')) return parseJson3(body);
  return parseVtt(body);
};

/**
 * Create an {@link IYtDlpTranscript}.
 *
 * @param deps Injected binary locator / spawner / temp-dir maker + tunables.
 */
export const createYtDlpTranscript = (deps: YtDlpTranscriptDeps = {}): IYtDlpTranscript => {
  const resolveBinary = deps.resolveBinary ?? (() => findExternalTool('yt-dlp'));
  const spawn = deps.spawn ?? defaultSpawn;
  const makeTempDir = deps.makeTempDir ?? (() => mkdtemp(join(tmpdir(), 'aionui-ytdlp-')));
  const preferLangs = deps.preferLangs ?? DEFAULT_PREFER_LANGS;
  const maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;

  const fetchTranscript = async (urlOrId: string): Promise<ExtractOutcome> => {
    const binary = await resolveBinary();
    if (!binary) return { ok: false, reason: 'yt-dlp not installed' };

    const url = /^https?:\/\//i.test(urlOrId) ? urlOrId : `https://www.youtube.com/watch?v=${urlOrId}`;
    let dir: string;
    try {
      dir = await makeTempDir();
    } catch (e) {
      return { ok: false, reason: 'ytdlp tempdir ' + (e instanceof Error ? e.message : String(e)) };
    }

    try {
      // Only the preferred language codes themselves (no `lang.*` wildcard): the
      // wildcard makes yt-dlp fan out to dozens of auto-translated variants
      // (en-de-DE, en-ja, …) which trips YouTube's 429 rate limiter. The bare
      // code still matches both the manual and the auto-generated (ASR) track.
      const langArg = preferLangs.join(',');
      const args = [
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs',
        langArg,
        '--sub-format',
        'json3/vtt/srv3/best',
        // Client selection (2025+): the default `web` client is gated behind a JS
        // runtime (Deno) + PO tokens — without one yt-dlp exits 1 ("No supported
        // JavaScript runtime"). The ANDROID client needs no JS runtime and still
        // serves caption tracks. Listing several lets yt-dlp use `web`/`web_safari`
        // when a JS runtime IS present (more/better tracks) and fall back to
        // `android` otherwise — so transcripts work with or without Deno.
        '--extractor-args',
        'youtube:player_client=web,web_safari,android',
        // yt-dlp 2026+ needs the yt-dlp-ejs challenge-solver lib to actually USE
        // the JS runtime (Deno): without it yt-dlp logs "[jsc] … solver script
        // (deno) … were skipped" and the YouTube JS/n challenge can't be solved,
        // so the caption tracks come back empty (the "innertube 400 / all empty"
        // symptom). `ejs:github` lets yt-dlp fetch that lib from the official
        // yt-dlp/ejs GitHub release on first use (cached afterwards). This is the
        // missing piece that makes Deno effective; harmless when no JS runtime is
        // present (yt-dlp just keeps using the android client).
        '--remote-components',
        'ejs:github',
        // Survive YouTube's 429 rate limiter (common when several videos are
        // summarised in a row): back off and retry instead of failing outright.
        '--retries',
        '5',
        '--retry-sleep',
        'http:exp=1:30',
        '--sleep-requests',
        '1',
        // Pause between caption-track downloads. We ask for a couple of langs
        // (vi,en); once ONE track is downloaded the rest are a bonus, but
        // back-to-back caption fetches are exactly what trips YouTube's 429.
        // A small inter-subtitle sleep keeps the first (and usually only needed)
        // track reliable.
        '--sleep-subtitles',
        '1',
        '--no-playlist',
        '-o',
        join(dir, '%(id)s.%(ext)s'),
      ];
      // Authenticate with the user's REAL YouTube session when a cookie exporter
      // is wired. A logged-in request is the single most effective way past the
      // anonymous HTTP 429 wall (YouTube's per-IP anonymous quota is tiny; a
      // signed-in request gets a far higher limit) and it also satisfies the
      // PO-token gate, so captions stop coming back empty. The cookie file lives
      // inside `dir`, deleted with the rest of the temp output after the fetch.
      if (deps.getCookieFile) {
        const cookieFile = await deps.getCookieFile(dir).catch((): null => null);
        if (cookieFile) args.push('--cookies', cookieFile);
      }
      if (deps.cookiesFromBrowser) args.push('--cookies-from-browser', deps.cookiesFromBrowser);
      args.push(url);

      // Generous timeout: retries with exponential back-off (for 429) can take
      // a while, and we'd rather wait than fall through to the gated in-page path.
      const { code, stderr } = await spawn(binary, args, { timeout: 180000, cwd: dir });
      const files = await readdir(dir).catch(() => [] as string[]);
      const subs = files.filter((f) => /\.(vtt|srt|srv\d|json3|json)$/i.test(f));
      if (subs.length === 0) {
        const err = clean(stderr);
        // Distinguish a genuine "this video has no captions" from a transient
        // rate-limit / gating failure, so the caller can decide whether to retry
        // later or fall back to research.
        const rateLimited = /429|too many requests/i.test(err);
        const noCaptions = /no subtitles for the requested|there are no subtitles/i.test(err);
        // yt-dlp couldn't run/fetch the JS-challenge solver (yt-dlp-ejs). With
        // `--remote-components ejs:github` set this should not happen, but if the
        // GitHub download is blocked or no JS runtime (Deno) is present the web
        // client returns empty caption tracks. Surface a precise hint instead of
        // mislabelling it "429".
        const solverSkipped = /challenge solver|remote component|no supported javascript runtime|jsc/i.test(err);
        const why = rateLimited
          ? 'rate-limited (HTTP 429)'
          : noCaptions
            ? 'no captions available'
            : solverSkipped
              ? 'JS-challenge solver unavailable (install Deno / allow GitHub for yt-dlp-ejs)'
              : `exit ${code}`;
        return { ok: false, reason: `ytdlp ${why}${err ? ': ' + err.slice(0, 120) : ''}` };
      }
      // Prefer a file whose name carries a preferred language code.
      const ranked = subs.toSorted((a, b) => langRank(a, preferLangs) - langRank(b, preferLangs));
      for (const file of ranked) {
        const body = await readFile(join(dir, file), 'utf-8').catch(() => '');
        const text = parseSubtitle(file.toLowerCase(), body);
        if (text) {
          return { ok: true, text: text.slice(0, maxChars), via: 'ytdlp', lang: langOf(file) };
        }
      }
      return { ok: false, reason: 'ytdlp subs found but all empty' };
    } catch (e) {
      return { ok: false, reason: 'ytdlp err ' + (e instanceof Error ? e.message : String(e)) };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };

  return { fetchTranscript };
};

/** Extract a language code from a subtitle file name like `<id>.vi.vtt`. */
const langOf = (file: string): string => {
  const m = file.match(/\.([a-z]{2}(?:-[A-Za-z]{2,})?)\.[^.]+$/);
  return m ? m[1] : '?';
};

/** Rank a subtitle file by language preference (lower = more preferred). */
const langRank = (file: string, preferLangs: string[]): number => {
  const lang = langOf(file).toLowerCase();
  const idx = preferLangs.findIndex((p) => lang.startsWith(p.toLowerCase()));
  return idx === -1 ? preferLangs.length : idx;
};
