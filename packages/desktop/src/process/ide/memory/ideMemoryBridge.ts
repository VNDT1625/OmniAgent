/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IDE session super-memory IPC bridge — the renderer-facing surface of the
 * ephemeral, per-session agent scratchpad ({@link getSessionMemoryStore}).
 *
 * The agent WRITES to the memory through the IDE MCP server (`ide_memory_*`
 * tools, see `mcp/ideServer.ts`); the renderer only needs two things:
 *
 *  - `ide.memory-snapshot` — read a point-in-time view to render a status badge
 *    ("N notes, X% of budget, secrets: …") next to the chat tab. Secret VALUES
 *    are never exposed — only the key names.
 *  - `ide.memory-clear` — drop a whole session. The IDE chat panel calls this
 *    when a tab is closed, fulfilling "close the tab → the memory is gone".
 *
 * Both consumers (this bridge and the MCP wiring) import the SAME singleton, so
 * the agent's writes and the UI's snapshot/clear all hit one in-RAM store.
 *
 * Channels use always-resolving envelopes so a renderer await never hangs.
 *
 * The global bootstrap calls {@link registerIdeMemoryBridge} once.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { getSessionMemoryStore, type SuperMemorySnapshot } from './sessionMemoryStore';

/** IPC channel names for the IDE session-memory surface. */
export const IDE_MEMORY_CHANNELS = {
  snapshot: 'ide.memory-snapshot',
  clear: 'ide.memory-clear',
} as const;

/** Always-resolving result envelope. */
export type IdeMemoryResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Request carrying the session id (the IDE chat conversation id). */
export type IdeMemoryRequest = { sessionId: string };

/** Typed channels. Exported for bootstrap registration wiring. */
export const ideMemoryChannels = {
  snapshot: bridge.buildProvider<IdeMemoryResult<SuperMemorySnapshot>, IdeMemoryRequest>(IDE_MEMORY_CHANNELS.snapshot),
  clear: bridge.buildProvider<IdeMemoryResult<boolean>, IdeMemoryRequest>(IDE_MEMORY_CHANNELS.clear),
};

/**
 * Register the IDE session-memory IPC handlers. Idempotent. Intended to be
 * called once during Main-process bootstrap.
 */
export function registerIdeMemoryBridge(): void {
  ideMemoryChannels.snapshot.provider(async (req): Promise<IdeMemoryResult<SuperMemorySnapshot>> => {
    try {
      return { ok: true, data: getSessionMemoryStore().snapshot(req.sessionId) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideMemoryChannels.clear.provider(async (req): Promise<IdeMemoryResult<boolean>> => {
    try {
      getSessionMemoryStore().clearSession(req.sessionId);
      return { ok: true, data: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
