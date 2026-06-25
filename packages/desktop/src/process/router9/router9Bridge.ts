/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 9Router connector IPC bridge — exposes the Main-process applier to the
 * renderer's "Distribute via 9Router" panel.
 *
 * Like the News/Manager bridges, this is an Electron-native bridge (not an
 * aioncore HTTP route), built with the `@office-ai/platform` `bridge` helper.
 * The channel-name constants ({@link ROUTER9_CHANNELS}) are the renderer-safe
 * contract — the renderer rebuilds matching invokers without importing this
 * Node-only module (see `router9BridgeClient.ts`).
 *
 * The single handler resolves an always-resolve {@link Router9Result} envelope:
 * the platform bridge swallows thrown errors (leaving `invoke()` pending
 * forever), so failures are surfaced as `{ ok: false, error }`.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { applyConnectorPlan, type ApplyResult } from './router9Applier';
import type { Router9Endpoint } from '@/common/router9';

/** IPC channel names for the 9Router connector surface. Safe to mirror in the renderer. */
export const ROUTER9_CHANNELS = {
  applyPlan: 'router9.apply-plan',
} as const;

/** Apply request: which target + the endpoint credentials to write. */
export type ApplyPlanRequest = {
  targetId: string;
  endpoint: Router9Endpoint;
};

/** Always-resolve result envelope. */
export type Router9Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** Typed channels. Exported for the bootstrap registration wiring. */
export const router9Channels = {
  applyPlan: bridge.buildProvider<Router9Result<ApplyResult>, ApplyPlanRequest>(ROUTER9_CHANNELS.applyPlan),
};

/**
 * Register the 9Router connector IPC handler.
 *
 * Idempotent: a repeated call re-registers the provider. Intended to be invoked
 * once during Main-process bootstrap.
 */
export function registerRouter9Bridge(): void {
  router9Channels.applyPlan.provider(async ({ targetId, endpoint }): Promise<Router9Result<ApplyResult>> => {
    try {
      const data = await applyConnectorPlan(targetId, endpoint);
      return { ok: true, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Router9Bridge] applyPlan failed:', error);
      return { ok: false, error: message };
    }
  });
}

export type { ApplyResult, AppliedFile } from './router9Applier';
