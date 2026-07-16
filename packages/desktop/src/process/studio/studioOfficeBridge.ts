/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Studio Office (.xlsx / .pptx) read/write IPC bridge (Yêu cầu 2a, criteria 2.3).
 *
 * Like `.docx`, these are binary ZIP files. Reading them in the renderer as text
 * shows garbage, so the work is done here in Main (Node) by file path:
 *
 * - `studio.xlsx-read`  — `xlsx-republish` reads the workbook → the first sheet
 *   is emitted as CSV text for tabular editing.
 * - `studio.xlsx-write` — CSV text → a workbook → written back as real `.xlsx`.
 * - `studio.pptx-read`  — unzip the `.pptx` (yauzl) and pull the text runs from
 *   each `ppt/slides/slideN.xml`, one block per slide. Read-only: no bundled
 *   `.pptx` writer is available, so editing/saving slides is out of scope here.
 *
 * The global bootstrap calls {@link registerStudioOfficeBridge} once. Process
 * boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { promises as fs } from 'node:fs';
import * as XLSX from 'xlsx-republish';
import yauzl from 'yauzl';

/** IPC channel names for the Studio office surface (renderer-safe contract). */
export const STUDIO_OFFICE_CHANNELS = {
  xlsxRead: 'studio.xlsx-read',
  xlsxWrite: 'studio.xlsx-write',
  pptxRead: 'studio.pptx-read',
} as const;

/** Request carrying just a file path (reads + the pptx read). */
export type OfficePathRequest = { path: string };
/** Request for {@link STUDIO_OFFICE_CHANNELS.xlsxWrite}. */
export type XlsxWriteRequest = { path: string; csv: string };

/** Result envelope — always resolves so the renderer can branch on `ok`. */
export type StudioOfficeResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Typed Studio office channels. Exported for bootstrap registration wiring. */
export const studioOfficeChannels = {
  xlsxRead: bridge.buildProvider<StudioOfficeResult<string>, OfficePathRequest>(STUDIO_OFFICE_CHANNELS.xlsxRead),
  xlsxWrite: bridge.buildProvider<StudioOfficeResult<boolean>, XlsxWriteRequest>(STUDIO_OFFICE_CHANNELS.xlsxWrite),
  pptxRead: bridge.buildProvider<StudioOfficeResult<string>, OfficePathRequest>(STUDIO_OFFICE_CHANNELS.pptxRead),
};

/** Read the first sheet of an `.xlsx` workbook as CSV text. */
const readXlsxCsv = async (filePath: string): Promise<string> => {
  const buffer = await fs.readFile(filePath);
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return '';
  const sheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_csv(sheet);
};

/** Build a one-sheet `.xlsx` from CSV text and write it to disk. */
const writeXlsxCsv = async (filePath: string, csv: string): Promise<boolean> => {
  const sheet = XLSX.utils.aoa_to_sheet(csv.split(/\r?\n/).map((line) => line.split(',')));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  const out = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  await fs.writeFile(filePath, out);
  return true;
};

/** Read a ZIP entry's full text content (yauzl, promisified). */
const readZipEntries = (
  filePath: string,
  match: (name: string) => boolean
): Promise<Array<{ name: string; text: string }>> =>
  new Promise((resolve, reject) => {
    // yauzl.open reads from disk directly (streams entries lazily).
    yauzl.open(filePath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) {
        reject(err ?? new Error('Could not open the .pptx archive.'));
        return;
      }
      const out: Array<{ name: string; text: string }> = [];
      zip.on('entry', (entry: yauzl.Entry) => {
        if (!match(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            zip.readEntry();
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out.push({ name: entry.fileName, text: Buffer.concat(chunks).toString('utf-8') });
            zip.readEntry();
          });
          stream.on('error', () => zip.readEntry());
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', (e: Error) => reject(e));
      zip.readEntry();
    });
  });

/** Extract visible text from a slide's XML (`<a:t>…</a:t>` runs). */
const slideXmlToText = (xml: string): string => {
  const runs = xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? [];
  return runs
    .map((run) => run.replace(/<\/?a:t>/g, ''))
    .map((s) =>
      s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
    )
    .join('\n')
    .trim();
};

/** Read a `.pptx` and return slide text blocks separated by `\n---\n`. */
const readPptxText = async (filePath: string): Promise<string> => {
  const entries = await readZipEntries(filePath, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  // Order slides by their numeric index (slide1, slide2, …).
  entries.sort((a, b) => {
    const na = Number(a.name.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
    const nb = Number(b.name.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
    return na - nb;
  });
  const blocks = entries.map((e) => slideXmlToText(e.text));
  return blocks.join('\n---\n');
};

/**
 * Register the Studio office IPC handlers. Idempotent. Intended to be called
 * once during Main-process bootstrap.
 */
export function registerStudioOfficeBridge(): void {
  const wrap =
    <Req, Res>(label: string, handler: (req: Req) => Promise<Res>) =>
    async (req: Req): Promise<StudioOfficeResult<Res>> => {
      try {
        return { ok: true, data: await handler(req) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[StudioOfficeBridge] ${label} failed:`, error);
        return { ok: false, error: message };
      }
    };

  studioOfficeChannels.xlsxRead.provider(wrap('xlsxRead', ({ path }: OfficePathRequest) => readXlsxCsv(path)));
  studioOfficeChannels.xlsxWrite.provider(
    wrap('xlsxWrite', ({ path, csv }: XlsxWriteRequest) => writeXlsxCsv(path, csv))
  );
  studioOfficeChannels.pptxRead.provider(wrap('pptxRead', ({ path }: OfficePathRequest) => readPptxText(path)));
}
