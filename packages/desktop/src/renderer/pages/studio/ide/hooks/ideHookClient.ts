/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the IDE Agent Hooks IPC surface.
 *
 * The Main-process bridge (`process/ide/hooks/ideHookBridge.ts`) imports
 * Node-only modules, so it must not be loaded in the renderer. Mirroring
 * `ideClient.ts`, this re-declares the channel-name strings, rebuilds matching
 * `bridge.buildProvider` / `buildEmitter` invokers, and borrows only **types**
 * via `import type`. Every call is timeout-guarded so an unregistered channel
 * rejects fast instead of hanging the UI.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type {
  IdeHookResult,
  IdeHookFiredEnvelope,
  SaveHookRequest,
  RemoveHookRequest,
  RunHookRequest,
  WorkspaceRequest,
} from '@process/ide/hooks/ideHookBridge';
import type { IdeHook, IdeHookFireRequest } from '@process/ide/hooks/ideHookTypes';

/** IDE-hook IPC channel names (mirror of the bridge channel consts). */
const IDE_HOOK_CHANNELS = {
  list: 'ide-hook.list',
  save: 'ide-hook.save',
  remove: 'ide-hook.remove',
  run: 'ide-hook.run',
  watchStart: 'ide-hook.watch-start',
  watchStop: 'ide-hook.watch-stop',
  fired: 'ide-hook.fired',
} as const;

/** Timeout (ms) for a hook CRUD/watch op (fast Node fs round-trip). */
const HOOK_OP_TIMEOUT_MS = 15000;

const channels = {
  list: bridge.buildProvider<IdeHookResult<IdeHook[]>, WorkspaceRequest>(IDE_HOOK_CHANNELS.list),
  save: bridge.buildProvider<IdeHookResult<IdeHook>, SaveHookRequest>(IDE_HOOK_CHANNELS.save),
  remove: bridge.buildProvider<IdeHookResult<IdeHook[]>, RemoveHookRequest>(IDE_HOOK_CHANNELS.remove),
  run: bridge.buildProvider<IdeHookResult<IdeHookFireRequest | null>, RunHookRequest>(IDE_HOOK_CHANNELS.run),
  watchStart: bridge.buildProvider<IdeHookResult<void>, WorkspaceRequest>(IDE_HOOK_CHANNELS.watchStart),
  watchStop: bridge.buildProvider<IdeHookResult<void>, WorkspaceRequest>(IDE_HOOK_CHANNELS.watchStop),
  fired: bridge.buildEmitter<IdeHookFiredEnvelope>(IDE_HOOK_CHANNELS.fired),
};

/** Error thrown when an IDE-hook IPC call does not reply within its budget. */
export class IdeHookTimeoutError extends Error {
  constructor(channel: string, timeoutMs: number) {
    super(`[IdeHookClient] No reply on "${channel}" after ${Math.round(timeoutMs / 1000)}s.`);
    this.name = 'IdeHookTimeoutError';
  }
}

/** Race an `invoke` against a timeout so an unregistered channel rejects fast. */
const invokeWithTimeout = <T>(channel: string, call: () => Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new IdeHookTimeoutError(channel, timeoutMs));
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

/** Timeout-guarded IDE-hook invokers for the renderer. */
export const ideHookClient = {
  list: (rootPath: string): Promise<IdeHookResult<IdeHook[]>> =>
    invokeWithTimeout(IDE_HOOK_CHANNELS.list, () => channels.list.invoke({ rootPath }), HOOK_OP_TIMEOUT_MS),
  save: (rootPath: string, hook: SaveHookRequest['hook']): Promise<IdeHookResult<IdeHook>> =>
    invokeWithTimeout(IDE_HOOK_CHANNELS.save, () => channels.save.invoke({ rootPath, hook }), HOOK_OP_TIMEOUT_MS),
  remove: (rootPath: string, id: string): Promise<IdeHookResult<IdeHook[]>> =>
    invokeWithTimeout(IDE_HOOK_CHANNELS.remove, () => channels.remove.invoke({ rootPath, id }), HOOK_OP_TIMEOUT_MS),
  run: (rootPath: string, id: string): Promise<IdeHookResult<IdeHookFireRequest | null>> =>
    invokeWithTimeout(IDE_HOOK_CHANNELS.run, () => channels.run.invoke({ rootPath, id }), HOOK_OP_TIMEOUT_MS),
  watchStart: (rootPath: string): Promise<IdeHookResult<void>> =>
    invokeWithTimeout(IDE_HOOK_CHANNELS.watchStart, () => channels.watchStart.invoke({ rootPath }), HOOK_OP_TIMEOUT_MS),
  watchStop: (rootPath: string): Promise<IdeHookResult<void>> =>
    invokeWithTimeout(IDE_HOOK_CHANNELS.watchStop, () => channels.watchStop.invoke({ rootPath }), HOOK_OP_TIMEOUT_MS),
  /** Subscribe to fired-hook events. Returns an unsubscribe fn. */
  onFired: (listener: (firing: IdeHookFireRequest) => void): (() => void) =>
    channels.fired.on((envelope) => listener(envelope.firing)),
};

export type { IdeHook, IdeHookFireRequest } from '@process/ide/hooks/ideHookTypes';
export type { IdeHookEvent, IdeHookActionKind } from '@process/ide/hooks/ideHookTypes';
