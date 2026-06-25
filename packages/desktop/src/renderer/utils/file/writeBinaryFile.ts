/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `writeBinaryFile` — binary-safe file write for the renderer.
 *
 * The aioncore `/api/fs/write` endpoint stores its `data` as literal UTF-8 text
 * (it does not base64-decode), so saving binary content (images, `.docx` ZIPs,
 * …) through it corrupts the bytes. The Main process exposes a raw-bytes writer
 * (`studio.write-binary`, see `process/studio/studioFsBridge.ts`); this helper
 * rebuilds the matching invoker from the channel name so any renderer module can
 * persist base64 payloads correctly without importing the Node-only bridge.
 *
 * Renderer-only. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';

/** Channel name — mirrors `STUDIO_FS_CHANNELS.writeBinary` in the Main bridge. */
const WRITE_BINARY_CHANNEL = 'studio.write-binary';
/** Channel name — mirrors `STUDIO_FS_CHANNELS.readBinary` in the Main bridge. */
const READ_BINARY_CHANNEL = 'studio.read-binary';

type WriteBinaryResult = { ok: true } | { ok: false; error: string };
type ReadBinaryResult = { ok: true; base64: string } | { ok: false; error: string };

/**
 * The failure arm of a result envelope. The project tsconfig runs without
 * `strictNullChecks`, where discriminant narrowing after a guard does not drop
 * the success member; reading `.error` in the failure branch via this cast is
 * safe because the guard (`!result.ok`) has already established the arm.
 */
type Failure = { ok: false; error: string };

const writeBinaryProvider = bridge.buildProvider<WriteBinaryResult, { path: string; base64: string }>(
  WRITE_BINARY_CHANNEL
);
const readBinaryProvider = bridge.buildProvider<ReadBinaryResult, { path: string }>(READ_BINARY_CHANNEL);

/** Race an invoke against a timeout so a missing bridge rejects instead of hanging. */
const withTimeout = <T>(call: () => Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Binary write timed out — the Studio fs bridge may not be wired (restart the app).'));
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

/**
 * Write base64-encoded bytes to `path` on disk (binary-safe).
 *
 * @param path - Absolute file path to (over)write.
 * @param base64 - Base64 payload (a `data:...;base64,` prefix is tolerated).
 * @throws if the write fails or the bridge does not answer in time.
 */
export const writeBinaryFile = async (path: string, base64: string): Promise<void> => {
  const result = await withTimeout(() => writeBinaryProvider.invoke({ path, base64 }), 30000);
  if (!result.ok) {
    throw new Error((result as Failure).error);
  }
};

/**
 * Read a file's raw bytes from disk by `path`, returned as base64.
 *
 * This is the byte-exact read used by the formatted viewers (docx-preview, …) —
 * it goes straight through the Main process, avoiding any renderer-side base64
 * round-trip that can corrupt a ZIP (the JSZip "end of central directory" error).
 *
 * @param path - Absolute file path to read.
 * @returns The file content as a base64 string (no data-URL prefix).
 * @throws if the read fails or the bridge does not answer in time.
 */
export const readBinaryFile = async (path: string): Promise<string> => {
  const result = await withTimeout(() => readBinaryProvider.invoke({ path }), 30000);
  if (!result.ok) {
    throw new Error((result as Failure).error);
  }
  return result.base64;
};

export default writeBinaryFile;
