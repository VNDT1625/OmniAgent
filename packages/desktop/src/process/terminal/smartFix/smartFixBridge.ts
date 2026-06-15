/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for Smart Fix command remaps.
 *
 * Called only when a command FAILS (a rare event, not a hot path), so a single
 * round-trip is fine. Resolves a deprecated program to its modern replacement
 * using the built-in seed plus Realtime Knowledge facts (topic `cmd.remap.<program>`).
 *
 * The global bootstrap calls {@link registerSmartFixBridge} once.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { lookupRemap, type Remap, type RemapResolver } from './commandRemap';
import { getRtkService } from '@process/knowledge/rtkWiring';
import type { IRtkService } from '@process/knowledge/realtime/rtkService';

/** Re-exported so the renderer client can import the remap type from one place. */
export type { Remap } from './commandRemap';

/** Always-resolving result envelope. */
export type SmartFixResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const SMART_FIX_CHANNELS = {
  remap: 'terminal.cmd-remap',
} as const;

/** Request: the failing command's program token. */
export type RemapRequest = { program: string };

export const smartFixChannels = {
  remap: bridge.buildProvider<SmartFixResult<Remap | null>, RemapRequest>(SMART_FIX_CHANNELS.remap),
};

/** Topic prefix under which command remaps are stored as RTK facts. */
const REMAP_TOPIC_PREFIX = 'cmd.remap.';

/** Build an RTK-backed remap resolver: find a fact `cmd.remap.<program>`. */
const buildRtkResolver = (resolveRtk: () => Promise<IRtkService>): RemapResolver => {
  return async (program) => {
    const rtk = await resolveRtk();
    const facts = await rtk.list();
    const fact = facts.find((f) => f.topic === `${REMAP_TOPIC_PREFIX}${program}` && f.status === 'active');
    if (!fact || fact.value.trim().length === 0) return null;
    return { to: fact.value.trim(), updateUrl: fact.sources[0]?.url };
  };
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Register the Smart Fix IPC handler. Idempotent.
 *
 * @param resolveRtk Injectable RTK accessor (defaults to the singleton).
 */
export function registerSmartFixBridge(resolveRtk: () => Promise<IRtkService> = getRtkService): void {
  const resolver = buildRtkResolver(resolveRtk);
  smartFixChannels.remap.provider(async (req): Promise<SmartFixResult<Remap | null>> => {
    const program = req?.program?.trim();
    if (!program) return { ok: true, data: null };
    try {
      return { ok: true, data: await lookupRemap(program, resolver) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });
}
