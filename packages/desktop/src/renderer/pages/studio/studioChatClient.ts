/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the Studio chat IPC surface.
 *
 * The Main-process bridge (`process/studio/studioChatBridge.ts`) imports Node
 * APIs, so it must not be loaded in the renderer. As with the company client,
 * the channel-name string is duplicated here and a matching invoker is rebuilt
 * with `bridge.buildProvider`; only types are borrowed via `import type`.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type { StudioChatRequest, StudioResult } from '@process/studio/studioChatBridge';
import type { StudioFsResult, WriteBinaryRequest } from '@process/studio/studioFsBridge';

/** Studio IPC channel names — mirror `STUDIO_CHANNELS` in the bridge. */
const STUDIO_CHANNELS = {
  chat: 'studio.chat',
} as const;

/** Studio fs IPC channel names — mirror `STUDIO_FS_CHANNELS` in the fs bridge. */
const STUDIO_FS_CHANNELS = {
  writeBinary: 'studio.write-binary',
} as const;

/**
 * Typed Studio invoker. `chat.invoke(req)` round-trips to the Main-process
 * handler registered by `registerStudioChatBridge` and resolves with a
 * {@link StudioResult} envelope (never rejects on a handled failure).
 */
export const studioChatClient = {
  chat: bridge.buildProvider<StudioResult<string>, StudioChatRequest>(STUDIO_CHANNELS.chat),
};

/**
 * Typed Studio fs invoker. `writeBinary.invoke(req)` writes decoded base64 bytes
 * straight to disk via the Main process (binary-safe — unlike `/api/fs/write`).
 */
export const studioFsClient = {
  writeBinary: bridge.buildProvider<StudioFsResult, WriteBinaryRequest>(STUDIO_FS_CHANNELS.writeBinary),
};

export type { StudioChatMessage, StudioChatRequest, StudioResult } from '@process/studio/studioChatBridge';
export type { StudioFsResult, WriteBinaryRequest } from '@process/studio/studioFsBridge';
