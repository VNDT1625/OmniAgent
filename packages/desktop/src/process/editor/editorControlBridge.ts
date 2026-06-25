/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge exposing the **editor frames** the Super agent has opened, so the
 * renderer can render one live {@link UniversalEditor} per frame inside the chat
 * watch grid (alongside browser frames).
 *
 * Mirrors `browserBridge`'s renderer-safe contract: the channel-name strings are
 * declared here and the renderer rebuilds matching `bridge.buildProvider`
 * invokers from them (without importing this Node module). The store is the
 * shared singleton the `editor_*` MCP tools mutate, so the agent and the
 * renderer observe the same set of frames.
 *
 * Process boundary: Main-process (Node.js) module.
 */

import { bridge } from '@office-ai/platform';
import { getEditorFrameStore, type EditorFrameInfo } from './editorFrameStore';

/** Editor-control IPC channel names (mirror in `editorControlClient.ts`). */
export const EDITOR_CHANNELS = {
  listFrames: 'editor.list-frames',
  closeFrame: 'editor.close-frame',
} as const;

/** Request addressing one editor frame by path. */
export type EditorFramePathRequest = {
  /** Path of the frame's file. */
  filePath: string;
};

/** Typed editor-control channels. Exported for bootstrap registration. */
export const editorChannels = {
  listFrames: bridge.buildProvider<EditorFrameInfo[], void>(EDITOR_CHANNELS.listFrames),
  closeFrame: bridge.buildProvider<void, EditorFramePathRequest>(EDITOR_CHANNELS.closeFrame),
};

/**
 * Register the editor-control IPC handlers. Idempotent (re-registration replaces
 * the bound handlers). Invoked once during Main-process bootstrap.
 */
export function registerEditorControlBridge(): void {
  const store = getEditorFrameStore();

  editorChannels.listFrames.provider(() => Promise.resolve(store.list()));
  editorChannels.closeFrame.provider(({ filePath }) => {
    store.close(filePath);
    return Promise.resolve();
  });
}

export type { EditorFrameInfo };
