/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the Main-process Office (.xlsx / .pptx) bridge.
 *
 * Mirrors `studioDocxClient` — rebuilds invokers from the channel-name strings
 * (the renderer must not import the Node-only bridge) and guards each call with
 * a timeout so an unregistered bridge errors instead of hanging. Renderer-only.
 */

import { bridge } from '@office-ai/platform';

/** Channel names — mirror `STUDIO_OFFICE_CHANNELS` in the bridge. */
const STUDIO_OFFICE_CHANNELS = {
  xlsxRead: 'studio.xlsx-read',
  xlsxWrite: 'studio.xlsx-write',
  pptxRead: 'studio.pptx-read',
} as const;

type OfficeResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** The failure arm of an {@link OfficeResult}; cast target under the no-`strictNullChecks` tsconfig. */
type OfficeFailure = { ok: false; error: string };

const xlsxReadProvider = bridge.buildProvider<OfficeResult<string>, { path: string }>(STUDIO_OFFICE_CHANNELS.xlsxRead);
const xlsxWriteProvider = bridge.buildProvider<OfficeResult<boolean>, { path: string; csv: string }>(
  STUDIO_OFFICE_CHANNELS.xlsxWrite
);
const pptxReadProvider = bridge.buildProvider<OfficeResult<string>, { path: string }>(STUDIO_OFFICE_CHANNELS.pptxRead);

/** Race an invoke against a timeout so a missing bridge rejects instead of hanging. */
const withTimeout = <T>(call: () => Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Office bridge timed out — restart the app so the bridge is wired.'));
    }, ms);
    call().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

/** Read the first sheet of an `.xlsx` as CSV text. Throws on a handled failure. */
export const readXlsxCsv = async (path: string): Promise<string> => {
  const result = await withTimeout(() => xlsxReadProvider.invoke({ path }), 30000);
  if (!result.ok) throw new Error((result as OfficeFailure).error);
  return result.data;
};

/** Write CSV text back as a one-sheet `.xlsx`. Throws on a handled failure. */
export const writeXlsxCsv = async (path: string, csv: string): Promise<void> => {
  const result = await withTimeout(() => xlsxWriteProvider.invoke({ path, csv }), 30000);
  if (!result.ok) throw new Error((result as OfficeFailure).error);
};

/** Read a `.pptx` slide text (blocks separated by `\n---\n`). Throws on failure. */
export const readPptxText = async (path: string): Promise<string> => {
  const result = await withTimeout(() => pptxReadProvider.invoke({ path }), 30000);
  if (!result.ok) throw new Error((result as OfficeFailure).error);
  return result.data;
};
