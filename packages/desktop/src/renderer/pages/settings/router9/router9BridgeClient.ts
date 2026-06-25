/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the 9Router connector IPC surface.
 *
 * The Main-process bridge module (`process/router9/router9Bridge.ts`) pulls in
 * Node `fs`/`os`, so it must NOT be imported into the renderer at runtime.
 * Mirroring `newsBridgeClient.ts`, this module re-declares the channel-name
 * strings (kept in sync with `ROUTER9_CHANNELS`), rebuilds matching invokers,
 * and wraps the call with a timeout so an unregistered channel rejects instead
 * of hanging. Only **types** are borrowed from Main via `import type`.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type { Router9Endpoint } from '@/common/router9';
import type { ApplyPlanRequest, ApplyResult, Router9Result } from '@process/router9/router9Bridge';

/** 9Router IPC channel names. Mirrors `ROUTER9_CHANNELS` in the bridge. */
const ROUTER9_CHANNELS = {
  applyPlan: 'router9.apply-plan',
} as const;

const channels = {
  applyPlan: bridge.buildProvider<Router9Result<ApplyResult>, ApplyPlanRequest>(ROUTER9_CHANNELS.applyPlan),
};

/** Apply writes files — allow a generous budget but still bound it. */
const APPLY_TIMEOUT_MS = 15_000;

/** Error thrown when the apply call does not reply within its budget. */
export class Router9BridgeTimeoutError extends Error {
  constructor(channel: string) {
    super(`[Router9BridgeClient] No reply on "${channel}" — the 9Router bridge may not be wired yet.`);
    this.name = 'Router9BridgeTimeoutError';
  }
}

/** Race an `invoke` against a timeout so a missing handler rejects, not hangs. */
const withTimeout = <T>(channel: string, call: () => Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Router9BridgeTimeoutError(channel));
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

/** Timeout-guarded 9Router connector invokers. */
export const router9Client = {
  /** Write the target's config files (deep-merge, with backup) for the endpoint. */
  applyPlan: (targetId: string, endpoint: Router9Endpoint) =>
    withTimeout(ROUTER9_CHANNELS.applyPlan, () => channels.applyPlan.invoke({ targetId, endpoint }), APPLY_TIMEOUT_MS),
};

export type { ApplyResult } from '@process/router9/router9Bridge';
