/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the Main-process Word (.docx) bridge.
 *
 * The bridge (`process/studio/studioDocxBridge.ts`) reads/writes the file by
 * path with Node `mammoth`/`docx` — robust where the renderer's base64 +
 * `mammoth.browser` path failed. This module rebuilds the matching invokers from
 * the channel-name strings (the renderer must not import the Node-only bridge);
 * each call is timeout-guarded so an unregistered bridge surfaces an error
 * instead of hanging. Renderer-only.
 */

import { bridge } from '@office-ai/platform';

/** Channel names — mirror `STUDIO_DOCX_CHANNELS` in the bridge. */
const STUDIO_DOCX_CHANNELS = {
  read: 'studio.docx-read',
  write: 'studio.docx-write',
} as const;

type DocxResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** The failure arm of a {@link DocxResult}; cast target under the no-`strictNullChecks` tsconfig. */
type DocxFailure = { ok: false; error: string };

const readProvider = bridge.buildProvider<DocxResult<string>, { path: string }>(STUDIO_DOCX_CHANNELS.read);
const writeProvider = bridge.buildProvider<DocxResult<boolean>, { path: string; text: string }>(
  STUDIO_DOCX_CHANNELS.write
);

/** Race an invoke against a timeout so a missing bridge rejects instead of hanging. */
const withTimeout = <T>(call: () => Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Word bridge timed out — restart the app so the bridge is wired.'));
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

/** Read a `.docx` file's plain text by path. Throws on a handled failure. */
export const readDocxText = async (path: string): Promise<string> => {
  const result = await withTimeout(() => readProvider.invoke({ path }), 30000);
  if (!result.ok) throw new Error((result as DocxFailure).error);
  return result.data;
};

/** Rebuild + write a clean `.docx` from text by path. Throws on a handled failure. */
export const writeDocxText = async (path: string, text: string): Promise<void> => {
  const result = await withTimeout(() => writeProvider.invoke({ path, text }), 30000);
  if (!result.ok) throw new Error((result as DocxFailure).error);
};
