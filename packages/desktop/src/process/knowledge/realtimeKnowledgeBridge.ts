/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge exposing the Realtime Knowledge service to the renderer inspector
 * (Settings → Realtime Knowledge). The renderer cannot reach the Main-process
 * service singleton directly, so this exposes a small read/maintenance surface
 * over typed channels. Every handler always resolves (never rejects) with a
 * `{ ok }` envelope so the UI degrades gracefully when the service is not ready.
 *
 * The global bootstrap calls {@link registerRealtimeKnowledgeBridge} once
 * (mirrors `knowledgeGraphBridge`); this module does not wire itself in.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import type { IRtkService } from './realtime/rtkService';
import type { GroundingPack } from './realtime/rtkService';
import type { KnowledgeFact, KnowledgeRelation } from './realtime/rtkTypes';
import { getRtkService } from './rtkWiring';

/** Always-resolving result envelope for the RTK bridge. */
export type RtkBridgeResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Channel names for the Realtime Knowledge inspector surface. */
export const RTK_CHANNELS = {
  list: 'rtk.list',
  lookup: 'rtk.lookup',
  refresh: 'rtk.refresh',
  relate: 'rtk.relate',
} as const;

/** Request for {@link RTK_CHANNELS.lookup}. */
export type RtkLookupRequest = { query: string; topK?: number };
/** Request for {@link RTK_CHANNELS.refresh}. */
export type RtkRefreshRequest = { topicOrId: string };
/** Request for {@link RTK_CHANNELS.relate}. */
export type RtkRelateRequest = { relation: KnowledgeRelation };

/** Typed RTK channels. Exported for the renderer client + bootstrap. */
export const rtkChannels = {
  list: bridge.buildProvider<RtkBridgeResult<KnowledgeFact[]>, void>(RTK_CHANNELS.list),
  lookup: bridge.buildProvider<RtkBridgeResult<GroundingPack>, RtkLookupRequest>(RTK_CHANNELS.lookup),
  refresh: bridge.buildProvider<RtkBridgeResult<KnowledgeFact>, RtkRefreshRequest>(RTK_CHANNELS.refresh),
  relate: bridge.buildProvider<RtkBridgeResult<boolean>, RtkRelateRequest>(RTK_CHANNELS.relate),
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Register the RTK inspector IPC handlers. Idempotent. The service is resolved
 * lazily per call so a model added after startup is picked up.
 *
 * @param resolveService Injectable service accessor (defaults to the singleton).
 */
export function registerRealtimeKnowledgeBridge(resolveService: () => Promise<IRtkService> = getRtkService): void {
  rtkChannels.list.provider(async (): Promise<RtkBridgeResult<KnowledgeFact[]>> => {
    try {
      return { ok: true, data: await (await resolveService()).list() };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  rtkChannels.lookup.provider(async (req): Promise<RtkBridgeResult<GroundingPack>> => {
    const query = req?.query?.trim();
    if (!query) return { ok: false, error: 'A query is required.' };
    try {
      const data = await (await resolveService()).lookup(query, req.topK ? { topK: req.topK } : undefined);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  rtkChannels.refresh.provider(async (req): Promise<RtkBridgeResult<KnowledgeFact>> => {
    const topicOrId = req?.topicOrId?.trim();
    if (!topicOrId) return { ok: false, error: 'A fact topic or id is required.' };
    try {
      return { ok: true, data: await (await resolveService()).refresh(topicOrId) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  rtkChannels.relate.provider(async (req): Promise<RtkBridgeResult<boolean>> => {
    if (!req?.relation) return { ok: false, error: 'A relation is required.' };
    try {
      await (await resolveService()).relate(req.relation);
      return { ok: true, data: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });
}
