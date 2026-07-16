/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the workspace IPC surface.
 *
 * The Main-process bridge module (`process/workspace/workspaceBridge.ts`) imports
 * Electron + Node-only modules, so it must NOT be imported into the renderer at
 * runtime. Mirroring `browserBridgeClient.ts`, this module:
 *
 * - re-declares the channel-name strings (kept in sync with `WORKSPACE_CHANNELS`),
 * - rebuilds matching `bridge.buildProvider(...)` invokers from those names, and
 * - borrows only **types** via `import type` (erased at compile time).
 *
 * `run` has no timeout wrapper — a workspace run legitimately lasts many seconds
 * across several sub-agents, and progress is observable via {@link onEvent}.
 * `cancel` is timeout-guarded so an unwired bridge rejects fast instead of
 * hanging.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type {
  RunWorkspaceBridgeRequest,
  WorkspaceEventEnvelope,
  WorkspaceRunIdRequest,
} from '@process/workspace/workspaceBridge';
import type { WorkspaceEvent, WorkspaceRunResult } from '@process/workspace/surfaceTypes';
import { WORKSPACE_BRIDGE_TIMEOUT_MS } from './constants';

/** Workspace IPC channel names (mirror of `WORKSPACE_CHANNELS` in the bridge). */
const WORKSPACE_CHANNELS = {
  run: 'workspace.run',
  cancel: 'workspace.cancel',
  event: 'workspace.event',
} as const;

/** Raw typed invokers — each `.invoke(req)` round-trips to the Main process. */
const channels = {
  run: bridge.buildProvider<WorkspaceRunResult, RunWorkspaceBridgeRequest>(WORKSPACE_CHANNELS.run),
  cancel: bridge.buildProvider<void, WorkspaceRunIdRequest>(WORKSPACE_CHANNELS.cancel),
  event: bridge.buildEmitter<WorkspaceEventEnvelope>(WORKSPACE_CHANNELS.event),
};

/** Error thrown when a workspace IPC call does not reply within its budget. */
export class WorkspaceBridgeTimeoutError extends Error {
  constructor(channel: string) {
    super(`[WorkspaceBridgeClient] No reply on "${channel}" — the workspace bridge may not be wired yet.`);
    this.name = 'WorkspaceBridgeTimeoutError';
  }
}

/** Race an `invoke` against a timeout so an unregistered channel rejects fast. */
const invokeWithTimeout = <T>(channel: string, call: () => Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new WorkspaceBridgeTimeoutError(channel));
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

/** Timeout-guarded workspace invokers for the renderer. */
export const workspaceClient = {
  /**
   * Start a workspace run. No timeout: the run lasts as long as its sub-agents
   * do; observe progress via {@link onEvent}. Rejects on bridge/handler error.
   */
  run: (request: RunWorkspaceBridgeRequest): Promise<WorkspaceRunResult> => channels.run.invoke(request),
  /** Cancel every surface of a run (best-effort). */
  cancel: (request: WorkspaceRunIdRequest): Promise<void> =>
    invokeWithTimeout(WORKSPACE_CHANNELS.cancel, () => channels.cancel.invoke(request), WORKSPACE_BRIDGE_TIMEOUT_MS),
  /** Subscribe to live workspace events (main → renderer). Returns an unsubscribe fn. */
  onEvent: (listener: (event: WorkspaceEvent) => void): (() => void) =>
    channels.event.on((envelope) => listener(envelope.event)),
};

export type { WorkspaceEvent, WorkspaceRunResult };
