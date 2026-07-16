/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the editor-control IPC surface — lists the editor
 * frames the Super agent has opened, so the watch grid can render a live
 * {@link UniversalEditor} per frame.
 *
 * Mirrors `browserBridgeClient.ts`: the channel-name strings are re-declared
 * here (kept in sync with `EDITOR_CHANNELS`), matching `bridge.buildProvider`
 * invokers are rebuilt from them, and only **types** are borrowed via
 * `import type`. Calls are timeout-guarded so an unwired bridge rejects fast.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type { EditorFrameInfo, EditorFramePathRequest } from '@process/editor/editorControlBridge';

/** Editor-control channel names (mirror of `EDITOR_CHANNELS` in the bridge). */
const EDITOR_CHANNELS = {
  listFrames: 'editor.list-frames',
  closeFrame: 'editor.close-frame',
} as const;

/** Short timeout so an unregistered channel rejects instead of hanging. */
const TIMEOUT_MS = 4000;

const channels = {
  listFrames: bridge.buildProvider<EditorFrameInfo[], void>(EDITOR_CHANNELS.listFrames),
  closeFrame: bridge.buildProvider<void, EditorFramePathRequest>(EDITOR_CHANNELS.closeFrame),
};

/** Race an `invoke` against a timeout. */
const invokeWithTimeout = <T>(call: () => Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('[editorControlClient] editor bridge timed out (not wired yet?).'));
    }, timeoutMs);
    call().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

/** Timeout-guarded editor-control invokers for the renderer. */
export const editorControlClient = {
  /** List the open editor frames (empty when the bridge is not wired). */
  listFrames: (): Promise<EditorFrameInfo[]> => invokeWithTimeout(() => channels.listFrames.invoke(), TIMEOUT_MS),
  /** Close one editor frame. */
  closeFrame: (filePath: string): Promise<void> =>
    invokeWithTimeout(() => channels.closeFrame.invoke({ filePath }), TIMEOUT_MS),
};

export type { EditorFrameInfo };
