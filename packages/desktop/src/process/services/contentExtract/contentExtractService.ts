/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Content-extraction facade — the single entry point every AI surface uses to
 * turn a source into clean Markdown/text for a model.
 *
 * It routes a {@link ExtractSource} to the right tiered pipeline:
 *
 *  - **youtube** → yt-dlp (primary) → an injected anonymous fetcher (fallback).
 *  - **file**    → markitdown via uvx (primary) → Node parsers (fallback).
 *  - **html**    → turndown (HTML string → Markdown).
 *  - **auto**    → sniff the input: YouTube URL → youtube; file path → file;
 *                  anything else with HTML markup → html.
 *
 * Centralising this means Browser (`summarize` / `video_transcript`), Manager
 * (`docExtractor`), Studio and others all share the same high-quality
 * extraction. Every collaborator is injected so the facade is unit-testable and
 * has no hard dependency on yt-dlp / uvx being installed.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import TurndownService from 'turndown';
import { createFileToMarkdown, type IFileToMarkdown } from './fileToMarkdown';
import { createYtDlpTranscript, type IYtDlpTranscript } from './ytDlpTranscript';
import type { ExtractOutcome } from './contentExtractTypes';

export type { ExtractOutcome, ExtractOk, ExtractFail, ExtractVia } from './contentExtractTypes';

/** A transcript fetcher used as the YouTube fallback tier (e.g. the existing anonymous one). */
export type FallbackTranscript = {
  /** Loose structural shape so any transcript fetcher (incl. the existing one) fits. */
  fetchTranscript(urlOrId: string): Promise<{ ok: boolean; text?: string; lang?: string; reason?: string }>;
};

/** A source to extract content from. */
export type ExtractSource =
  /** A YouTube video URL or 11-char id. */
  | { kind: 'youtube'; urlOrId: string }
  /** A local file path. */
  | { kind: 'file'; path: string }
  /** A raw HTML string (already fetched), with an optional source title. */
  | { kind: 'html'; html: string; title?: string }
  /** Auto-detect from a string (URL / file path / HTML). */
  | { kind: 'auto'; input: string };

/** Dependencies for {@link createContentExtractService}. */
export type ContentExtractServiceDeps = {
  /** Primary YouTube transcript fetcher. Defaults to the yt-dlp one. */
  ytDlp?: IYtDlpTranscript;
  /** Fallback YouTube transcript fetcher (e.g. the existing anonymous fetcher). Optional. */
  ytFallback?: FallbackTranscript;
  /** File → Markdown converter. Defaults to the markitdown+Node one. */
  fileToMarkdown?: IFileToMarkdown;
  /** Max characters returned. Defaults to 100000. */
  maxChars?: number;
};

/** Public contract of the content-extraction service. */
export type IContentExtractService = {
  /** Extract a source to Markdown/text. Never rejects; `ok:false` on failure. */
  extract(source: ExtractSource): Promise<ExtractOutcome>;
};

const DEFAULT_MAX_CHARS = 100000;

/** Heuristic: does a string look like a YouTube URL/id? */
const isYoutube = (input: string): boolean => /(?:youtube\.com\/|youtu\.be\/|^[\w-]{11}$)/i.test(input.trim());

/** Heuristic: does a string look like a local file path (not a URL)? */
const looksLikeFilePath = (input: string): boolean => {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) return false;
  return /[\\/]/.test(s) && /\.[a-z0-9]{1,8}$/i.test(s);
};

/** Heuristic: does a string contain HTML markup? */
const looksLikeHtml = (input: string): boolean => /<\/?[a-z][\s\S]*>/i.test(input);

/**
 * Create an {@link IContentExtractService}.
 *
 * @param deps Injected tiered extractors. Sensible defaults are constructed when
 *   omitted (yt-dlp transcript + markitdown/Node file converter).
 */
export const createContentExtractService = (deps: ContentExtractServiceDeps = {}): IContentExtractService => {
  const ytDlp = deps.ytDlp ?? createYtDlpTranscript();
  const fileToMarkdown = deps.fileToMarkdown ?? createFileToMarkdown();
  const maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;

  /** YouTube: yt-dlp first, then the optional anonymous fallback. */
  const extractYoutube = async (urlOrId: string): Promise<ExtractOutcome> => {
    const primary = await ytDlp.fetchTranscript(urlOrId);
    if (primary.ok) return cap(primary, maxChars);
    const reasons: string[] = [(primary as { reason?: string }).reason ?? ''];
    if (deps.ytFallback) {
      const fb = await deps.ytFallback.fetchTranscript(urlOrId);
      if (fb.ok && typeof fb.text === 'string' && fb.text.length > 0) {
        return cap({ ok: true, text: fb.text, via: 'yt-anonymous', lang: fb.lang }, maxChars);
      }
      reasons.push(fb.reason ?? '');
    }
    return { ok: false, reason: reasons.filter(Boolean).join(' | ') || 'no transcript' };
  };

  /** HTML string → Markdown via turndown. */
  const extractHtml = (html: string, title?: string): ExtractOutcome => {
    try {
      const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
      const md = td.turndown(html).trim();
      if (!md) return { ok: false, reason: 'html produced empty markdown' };
      return { ok: true, text: md.slice(0, maxChars), via: 'node-turndown', title };
    } catch (e) {
      return { ok: false, reason: 'html err ' + (e instanceof Error ? e.message : String(e)) };
    }
  };

  const extract = async (source: ExtractSource): Promise<ExtractOutcome> => {
    switch (source.kind) {
      case 'youtube':
        return extractYoutube(source.urlOrId);
      case 'file':
        return cap(await fileToMarkdown.toMarkdown(source.path), maxChars);
      case 'html':
        return extractHtml(source.html, source.title);
      case 'auto': {
        const input = source.input;
        if (isYoutube(input)) return extractYoutube(input);
        if (looksLikeFilePath(input)) return cap(await fileToMarkdown.toMarkdown(input), maxChars);
        if (looksLikeHtml(input)) return extractHtml(input);
        return { ok: false, reason: 'could not classify input (not a YouTube URL, file path, or HTML)' };
      }
    }
  };

  return { extract };
};

/** Cap a successful outcome's text length (pass failures through unchanged). */
const cap = (outcome: ExtractOutcome, maxChars: number): ExtractOutcome => {
  if (outcome.ok === true && outcome.text.length > maxChars) {
    return { ...outcome, text: outcome.text.slice(0, maxChars) };
  }
  return outcome;
};

/** A shared, lazily-built default service for the simple `import and use` case. */
let shared: IContentExtractService | undefined;

/**
 * Resolve the process-wide default content-extraction service (built on first
 * use with yt-dlp + markitdown/Node defaults). Callers that need custom wiring
 * (e.g. to plug in the existing anonymous transcript fetcher as a fallback)
 * should use {@link createContentExtractService} directly.
 */
export const getContentExtractService = (): IContentExtractService => {
  if (!shared) shared = createContentExtractService();
  return shared;
};
