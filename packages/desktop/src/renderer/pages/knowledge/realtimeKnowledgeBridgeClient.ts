/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the Realtime Knowledge IPC surface.
 *
 * The Main-process bridge module (`process/knowledge/realtimeKnowledgeBridge.ts`)
 * pulls in Electron + Node `fs` via the service wiring, so it must NOT be
 * imported into the renderer at runtime. This module re-declares the channel
 * names and rebuilds matching `bridge.buildProvider(...)` invokers — exactly the
 * pattern `companyBridgeClient.ts` uses. Only **types** are borrowed via
 * `import type` (erased at compile time, safe across the boundary).
 *
 * Each call resolves with an `{ ok }` envelope (never rejects on a handled
 * failure), so the inspector page degrades to an error state instead of hanging.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type {
  RtkBridgeResult,
  RtkLookupRequest,
  RtkRefreshRequest,
  RtkRelateRequest,
} from '@process/knowledge/realtimeKnowledgeBridge';
import type { GroundingPack } from '@process/knowledge/realtime/rtkService';
import type { KnowledgeFact } from '@process/knowledge/realtime/rtkTypes';

/** RTK channel names. Mirror `RTK_CHANNELS` in the Main-process bridge. */
const RTK_CHANNELS = {
  list: 'rtk.list',
  lookup: 'rtk.lookup',
  refresh: 'rtk.refresh',
  relate: 'rtk.relate',
} as const;

/** Typed RTK invokers for the renderer. */
export const realtimeKnowledgeClient = {
  list: bridge.buildProvider<RtkBridgeResult<KnowledgeFact[]>, void>(RTK_CHANNELS.list),
  lookup: bridge.buildProvider<RtkBridgeResult<GroundingPack>, RtkLookupRequest>(RTK_CHANNELS.lookup),
  refresh: bridge.buildProvider<RtkBridgeResult<KnowledgeFact>, RtkRefreshRequest>(RTK_CHANNELS.refresh),
  relate: bridge.buildProvider<RtkBridgeResult<boolean>, RtkRelateRequest>(RTK_CHANNELS.relate),
};

/** Wrap an invoke so an unregistered bridge (e.g. WebUI mode) cannot hang the UI. */
const withTimeout = async <T>(promise: Promise<RtkBridgeResult<T>>, ms = 8000): Promise<RtkBridgeResult<T>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RtkBridgeResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: 'unavailable' }), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** List all stored facts (newest first). */
export const fetchFacts = (): Promise<RtkBridgeResult<KnowledgeFact[]>> =>
  withTimeout(realtimeKnowledgeClient.list.invoke());

/** Semantic lookup for a query. */
export const lookupFacts = (query: string, topK?: number): Promise<RtkBridgeResult<GroundingPack>> =>
  withTimeout(realtimeKnowledgeClient.lookup.invoke({ query, topK }));

/** Force-refresh a fact by topic or id. */
export const refreshFact = (topicOrId: string): Promise<RtkBridgeResult<KnowledgeFact>> =>
  withTimeout(realtimeKnowledgeClient.refresh.invoke({ topicOrId }), 30000);
