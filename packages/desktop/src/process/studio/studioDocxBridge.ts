/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Studio Word (.docx) read/write IPC bridge (Yêu cầu 2a, criterion 2.2).
 *
 * Editing a `.docx` in the renderer proved fragile: `mammoth.browser` + `atob`
 * decoding of the base64 the binary loader returns could fail on real-world
 * documents (showing the JSZip "end of central directory" error / mojibake).
 *
 * This bridge does the work in the Main process instead, exactly the way the
 * verified probe does it — and it reads the file **straight from disk by path**,
 * so there is no base64/`atob` round-trip to corrupt:
 *
 * - `studio.docx-read`  — `fs.readFile(path)` → Node `mammoth.extractRawText`
 *   → plain text. Falls back to a UTF-8 decode when the bytes are not a valid
 *   `.docx` ZIP so a damaged file still opens (and can be re-saved clean).
 * - `studio.docx-write` — rebuild a clean `.docx` from text with the `docx`
 *   library and write the real bytes to disk.
 *
 * The global bootstrap calls {@link registerStudioDocxBridge} once. Process
 * boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import { promises as fs } from 'node:fs';

/** IPC channel names for the Studio docx surface (renderer-safe contract). */
export const STUDIO_DOCX_CHANNELS = {
  read: 'studio.docx-read',
  write: 'studio.docx-write',
} as const;

/** Request for {@link STUDIO_DOCX_CHANNELS.read}. */
export type DocxReadRequest = { path: string };
/** Request for {@link STUDIO_DOCX_CHANNELS.write}. */
export type DocxWriteRequest = { path: string; text: string };

/** Result envelope — always resolves so the renderer can branch on `ok`. */
export type StudioDocxResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Typed Studio docx channels. Exported for bootstrap registration wiring. */
export const studioDocxChannels = {
  read: bridge.buildProvider<StudioDocxResult<string>, DocxReadRequest>(STUDIO_DOCX_CHANNELS.read),
  write: bridge.buildProvider<StudioDocxResult<boolean>, DocxWriteRequest>(STUDIO_DOCX_CHANNELS.write),
};

/** Whether a buffer begins with the ZIP local-file-header magic "PK\x03\x04". */
const isZip = (buf: Buffer): boolean =>
  buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

/** Read a `.docx`/`.doc` file's plain text (resilient to corrupted files). */
const readDocx = async (filePath: string): Promise<string> => {
  const buffer = await fs.readFile(filePath);
  if (isZip(buffer)) {
    // Modern .docx (ZIP) → mammoth.
    try {
      const result = await mammoth.extractRawText({ buffer });
      return result.value.replace(/\r\n/g, '\n');
    } catch {
      // Fall through to the fallbacks below.
    }
  } else {
    // Legacy binary .doc (OLE compound file, not a ZIP) → word-extractor.
    try {
      const extractor = new WordExtractor();
      const doc = await extractor.extract(buffer);
      const body = doc.getBody();
      if (typeof body === 'string' && body.trim().length > 0) {
        return body.replace(/\r\n/g, '\n');
      }
    } catch {
      // Fall through to the text fallback below.
    }
  }
  // Last resort (damaged file): decode as text so it still opens; saving will
  // rebuild a clean .docx.
  return buffer.toString('utf-8').replace(/\r\n/g, '\n');
};

/** Build a clean `.docx` from text (one paragraph per line) and write it. */
const writeDocx = async (filePath: string, text: string): Promise<boolean> => {
  const lines = text.split('\n');
  const paragraphs = lines.map((line) => new Paragraph({ children: [new TextRun(line)] }));
  const doc = new Document({
    sections: [{ properties: {}, children: paragraphs.length > 0 ? paragraphs : [new Paragraph({})] }],
  });
  const buffer = await Packer.toBuffer(doc);
  await fs.writeFile(filePath, buffer);
  return true;
};

/**
 * Register the Studio docx IPC handlers. Idempotent (re-registration replaces
 * the bound handler). Intended to be called once during Main-process bootstrap.
 */
export function registerStudioDocxBridge(): void {
  studioDocxChannels.read.provider(async (req): Promise<StudioDocxResult<string>> => {
    try {
      if (!req.path || req.path.trim().length === 0) throw new Error('A file path is required.');
      return { ok: true, data: await readDocx(req.path) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[StudioDocxBridge] read failed:', error);
      return { ok: false, error: message };
    }
  });

  studioDocxChannels.write.provider(async (req): Promise<StudioDocxResult<boolean>> => {
    try {
      if (!req.path || req.path.trim().length === 0) throw new Error('A file path is required.');
      return { ok: true, data: await writeDocx(req.path, req.text) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[StudioDocxBridge] write failed:', error);
      return { ok: false, error: message };
    }
  });
}
