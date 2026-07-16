/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Document → text extraction for the Manager "Import from files + prompt" flow.
 *
 * The renderer can read plain-text files inline, but binary office/PDF formats
 * must be extracted in the Main process (Node) by path. This module reads a list
 * of absolute paths and returns each file's text content, so the AI schedule
 * parser can treat PDF/DOCX/PPTX/XLSX the same as a typed prompt.
 *
 * Extraction strategy per kind:
 * - **PDF / DOCX / PPTX / XLSX / ODT / ODP / ODS**: `officeparser` (already a
 *   project dependency) — one call covers all office + PDF formats.
 * - **Text-like** (md/json/csv/txt/…): read as UTF-8 directly.
 * - **Images**: not handled here — the renderer downscales them and sends data
 *   URLs through the multimodal channel instead.
 *
 * Every failure degrades to an empty string for that file (with a logged
 * warning) so one unreadable attachment never fails the whole import. Output is
 * truncated per file to keep the model prompt bounded.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Max characters kept per extracted document (keeps the prompt bounded). */
export const MAX_DOC_CHARS = 20_000;

/** Extracted text for one input file. */
export type ExtractedDoc = {
  /** Base file name (for the model's context + the UI chip). */
  name: string;
  /** Extracted UTF-8 text (possibly truncated), or '' when extraction failed. */
  text: string;
  /** Set when extraction failed, for a friendly per-file note. */
  error?: string;
};

const OFFICE_EXTS = new Set(['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.odt', '.odp', '.ods']);
const TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.tsv',
  '.yaml',
  '.yml',
  '.log',
  '.ics',
  '.xml',
  '.html',
  '.htm',
  '.rtf',
]);

/** Truncate to {@link MAX_DOC_CHARS}, noting when content was cut. */
const clamp = (text: string): string =>
  text.length > MAX_DOC_CHARS ? text.slice(0, MAX_DOC_CHARS) + '\n…[truncated]' : text;

/** Extract text from one office/PDF file via the shared content-extract service. */
const extractOffice = async (filePath: string): Promise<string> => {
  // Prefer the shared content-extract service: markitdown (via uvx) → Node
  // fallbacks. This yields structured Markdown (headings/tables) instead of flat
  // text, improving downstream model answers. Degrades to officeparser when
  // markitdown is unavailable, so behaviour never regresses.
  const { getContentExtractService } = await import('@process/services/contentExtract');
  const out = await getContentExtractService().extract({ kind: 'file', path: filePath });
  if (out.ok && out.text.trim()) return out.text;

  // Last-resort direct officeparser (the service already tries this, but keep an
  // explicit fallback in case the service itself is unavailable in some build).
  const officeparser = await import('officeparser');
  const parse = (officeparser as { parseOfficeAsync?: (p: string) => Promise<string> }).parseOfficeAsync;
  if (typeof parse !== 'function') throw new Error('officeparser unavailable');
  const text = await parse(filePath);
  return typeof text === 'string' ? text : '';
};

/**
 * Extract text from a list of absolute file paths.
 *
 * Returns one {@link ExtractedDoc} per input (order preserved). Never throws —
 * a file that cannot be read yields `{ text: '', error }`.
 */
export const extractDocs = async (paths: string[]): Promise<ExtractedDoc[]> => {
  const out: ExtractedDoc[] = [];
  for (const filePath of paths) {
    const name = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    try {
      let text = '';
      if (OFFICE_EXTS.has(ext)) {
        text = await extractOffice(filePath);
      } else if (TEXT_EXTS.has(ext) || ext === '') {
        text = await fs.promises.readFile(filePath, 'utf-8');
      } else {
        // Unknown extension: try as UTF-8 text, best-effort.
        text = await fs.promises.readFile(filePath, 'utf-8');
      }
      out.push({ name, text: clamp(text.trim()) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Manager] Failed to extract "${name}":`, message);
      out.push({ name, text: '', error: message });
    }
  }
  return out;
};
