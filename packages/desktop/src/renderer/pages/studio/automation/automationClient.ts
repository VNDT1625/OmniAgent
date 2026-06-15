/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the Automation IPC surface.
 *
 * The Main-process bridge (`process/automation/automationBridge.ts`) imports
 * Node-only modules, so it must not be loaded in the renderer. Mirroring
 * `workspaceBridgeClient.ts`, this module re-declares the channel-name strings,
 * rebuilds matching `bridge.buildProvider` / `bridge.buildEmitter` invokers, and
 * borrows only **types** via `import type` (erased at compile time).
 *
 * Result-bearing calls are timeout-guarded so an unwired bridge rejects fast
 * instead of hanging the page. `run` returns immediately with a runId; progress
 * streams through {@link automationClient.onEvent}.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type {
  AutomationResult,
  AutomationIdRequest,
  CancelRunRequest,
  RunEventEnvelope,
  RunWorkflowRequest,
  RunWorkflowResult,
  SaveWorkflowRequest,
} from '@process/automation/automationBridge';
import type { RunEvent, Workflow } from '@process/automation/automationTypes';

/** Automation IPC channel names (mirror of `AUTOMATION_CHANNELS` in the bridge). */
const AUTOMATION_CHANNELS = {
  list: 'automation.list',
  get: 'automation.get',
  save: 'automation.save',
  remove: 'automation.remove',
  run: 'automation.run',
  cancel: 'automation.cancel',
  event: 'automation.event',
} as const;

/** Default timeout (ms) for a result-bearing automation call. */
const AUTOMATION_TIMEOUT_MS = 8000;

/** Raw typed invokers — each `.invoke(req)` round-trips to the Main process. */
const channels = {
  list: bridge.buildProvider<AutomationResult<Workflow[]>, void>(AUTOMATION_CHANNELS.list),
  get: bridge.buildProvider<AutomationResult<Workflow | null>, AutomationIdRequest>(AUTOMATION_CHANNELS.get),
  save: bridge.buildProvider<AutomationResult<Workflow>, SaveWorkflowRequest>(AUTOMATION_CHANNELS.save),
  remove: bridge.buildProvider<AutomationResult<Workflow[]>, AutomationIdRequest>(AUTOMATION_CHANNELS.remove),
  run: bridge.buildProvider<AutomationResult<RunWorkflowResult>, RunWorkflowRequest>(AUTOMATION_CHANNELS.run),
  cancel: bridge.buildProvider<AutomationResult<void>, CancelRunRequest>(AUTOMATION_CHANNELS.cancel),
  event: bridge.buildEmitter<RunEventEnvelope>(AUTOMATION_CHANNELS.event),
};

/** Error thrown when an automation IPC call does not reply within its budget. */
export class AutomationBridgeTimeoutError extends Error {
  constructor(channel: string) {
    super(`[AutomationClient] No reply on "${channel}" — the automation bridge may not be wired yet.`);
    this.name = 'AutomationBridgeTimeoutError';
  }
}

/** Race an `invoke` against a timeout so an unregistered channel rejects fast. */
const invokeWithTimeout = <T>(channel: string, call: () => Promise<T>, timeoutMs = AUTOMATION_TIMEOUT_MS): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new AutomationBridgeTimeoutError(channel));
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

/** Timeout-guarded automation invokers for the renderer. */
export const automationClient = {
  list: (): Promise<AutomationResult<Workflow[]>> =>
    invokeWithTimeout(AUTOMATION_CHANNELS.list, () => channels.list.invoke()),
  get: (id: string): Promise<AutomationResult<Workflow | null>> =>
    invokeWithTimeout(AUTOMATION_CHANNELS.get, () => channels.get.invoke({ id })),
  save: (workflow: SaveWorkflowRequest['workflow']): Promise<AutomationResult<Workflow>> =>
    invokeWithTimeout(AUTOMATION_CHANNELS.save, () => channels.save.invoke({ workflow })),
  remove: (id: string): Promise<AutomationResult<Workflow[]>> =>
    invokeWithTimeout(AUTOMATION_CHANNELS.remove, () => channels.remove.invoke({ id })),
  run: (id: string): Promise<AutomationResult<RunWorkflowResult>> =>
    invokeWithTimeout(AUTOMATION_CHANNELS.run, () => channels.run.invoke({ id })),
  cancel: (runId: string): Promise<AutomationResult<void>> =>
    invokeWithTimeout(AUTOMATION_CHANNELS.cancel, () => channels.cancel.invoke({ runId })),
  /** Subscribe to live run-log events (main → renderer). Returns an unsubscribe fn. */
  onEvent: (listener: (event: RunEvent) => void): (() => void) =>
    channels.event.on((envelope) => listener(envelope.event)),
};

export type { RunEvent, Workflow };
export type { WorkflowNode, WorkflowNodeKind, NodeErrorPolicy } from '@process/automation/automationTypes';
