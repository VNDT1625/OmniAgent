/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the content-extraction service
 * (`process/services/contentExtract/`).
 *
 * The service turns three kinds of source — a YouTube video, a local file
 * (PDF/Word/PPT/Excel/…), or raw HTML — into clean **Markdown/text** that any
 * AI surface (Browser web-agent, Studio chat, IDE, Manager, Make Video, Testing)
 * can feed to a model. Centralising it means every surface gets the same
 * high-quality extraction (yt-dlp → fallback for transcripts; markitdown →
 * Node fallback for files) instead of each re-implementing a weaker version.
 *
 * Process boundary: Main-process (Node.js) modules. No DOM APIs.
 */

/** Which extraction pipeline produced a result (for diagnostics / logging). */
export type ExtractVia =
  | 'ytdlp'
  | 'yt-anonymous'
  | 'markitdown'
  | 'node-mammoth'
  | 'node-officeparser'
  | 'node-turndown'
  | 'node-text'
  | 'none';

/** A successful extraction. */
export type ExtractOk = {
  /** Whether content was extracted. */
  ok: true;
  /** The extracted Markdown/plain text (whitespace-normalised, length-capped). */
  text: string;
  /** Which pipeline produced it. */
  via: ExtractVia;
  /** Optional detected title (file name, video title, page title). */
  title?: string;
  /** Optional BCP-47 language code (transcripts). */
  lang?: string;
};

/** A failed extraction, carrying a short diagnostic of every attempt. */
export type ExtractFail = {
  /** Whether content was extracted. */
  ok: false;
  /** Short, joined diagnostic of every attempt (for logs / the agent observation). */
  reason: string;
};

/** Result of any extraction call; never rejects so callers can fall back cleanly. */
export type ExtractOutcome = ExtractOk | ExtractFail;
