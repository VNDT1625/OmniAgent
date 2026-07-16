/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IDE Agent Hooks IPC bridge — the Main-process plane for workspace automations
 * that react to IDE file events. It owns:
 *
 *  - a per-workspace {@link IIdeHookStore} (CRUD, persisted JSON),
 *  - one active {@link RepoWatcher} that, while a workspace is "watched", turns
 *    debounced file-change batches into hook firings ({@link computeHookFirings})
 *    and pushes each as a `ide-hook.fired` event to the renderer.
 *
 * The renderer performs the action (ask the IDE Chat agent / run a terminal
 * command) because that is where those surfaces live; the Main process only
 * decides WHICH hook fires and for WHICH file. Manual firing is request/response
 * (`ide-hook.run`) and returns the fire descriptor for the renderer to dispatch.
 *
 * All result channels resolve an always-resolving envelope so the renderer can
 * branch on `ok` instead of hanging on a swallowed rejection.
 *
 * The global bootstrap calls {@link registerIdeHookBridge} once.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import * as fs from 'node:fs';
import { createIdeHookStore, type IIdeHookStore } from './ideHookStore';
import { computeHookFirings, manualFiring } from './ideHookEngine';
import { createRepoWatcher, type FsWatcherHandle, type RawWatchEventType, type RepoWatcher } from '../repoWatcher';
import type { IdeHook, IdeHookFireRequest } from './ideHookTypes';

/** IPC channel names for the IDE hooks surface (renderer-safe contract). */
export const IDE_HOOK_CHANNELS = {
  list: 'ide-hook.list',
  save: 'ide-hook.save',
  remove: 'ide-hook.remove',
  run: 'ide-hook.run',
  watchStart: 'ide-hook.watch-start',
  watchStop: 'ide-hook.watch-stop',
  fired: 'ide-hook.fired',
} as const;

/** Always-resolving result envelope. */
export type IdeHookResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Request scoped to one workspace. */
export type WorkspaceRequest = { rootPath: string };
/** Save request: the workspace + the (partial) hook to upsert. */
export type SaveHookRequest = { rootPath: string; hook: Partial<IdeHook> & { name: string } };
/** Remove request. */
export type RemoveHookRequest = { rootPath: string; id: string };
/** Manual-run request. */
export type RunHookRequest = { rootPath: string; id: string };

/**
 * Envelope wrapping a fired-hook descriptor. Boxing keeps the platform
 * `buildEmitter<Params>` conditional non-distributive (the same trick the other
 * bridges use to avoid collapsing the union to `never`).
 */
export type IdeHookFiredEnvelope = { firing: IdeHookFireRequest };

/** Typed IDE-hook channels. Exported for bootstrap registration wiring. */
export const ideHookChannels = {
  list: bridge.buildProvider<IdeHookResult<IdeHook[]>, WorkspaceRequest>(IDE_HOOK_CHANNELS.list),
  save: bridge.buildProvider<IdeHookResult<IdeHook>, SaveHookRequest>(IDE_HOOK_CHANNELS.save),
  remove: bridge.buildProvider<IdeHookResult<IdeHook[]>, RemoveHookRequest>(IDE_HOOK_CHANNELS.remove),
  run: bridge.buildProvider<IdeHookResult<IdeHookFireRequest | null>, RunHookRequest>(IDE_HOOK_CHANNELS.run),
  watchStart: bridge.buildProvider<IdeHookResult<void>, WorkspaceRequest>(IDE_HOOK_CHANNELS.watchStart),
  watchStop: bridge.buildProvider<IdeHookResult<void>, WorkspaceRequest>(IDE_HOOK_CHANNELS.watchStop),
  fired: bridge.buildEmitter<IdeHookFiredEnvelope>(IDE_HOOK_CHANNELS.fired),
};

/** One store per workspace root, created lazily and cached. */
const stores = new Map<string, IIdeHookStore>();

const storeFor = (rootPath: string): IIdeHookStore => {
  let store = stores.get(rootPath);
  if (!store) {
    store = createIdeHookStore({ rootPath });
    stores.set(rootPath, store);
  }
  return store;
};

/** The single active watcher + the workspace it is bound to. */
let watcher: RepoWatcher | null = null;

/** Build the real fs-backed watcher (mirrors knowledgeGraphBridge's wiring). */
const buildWatcher = (): RepoWatcher =>
  createRepoWatcher({
    watch: (rootPath, onEvent): FsWatcherHandle => {
      const fsWatcher = fs.watch(rootPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const rel = String(filename);
        onEvent(eventType as RawWatchEventType, rel);
      });
      return { close: () => fsWatcher.close() };
    },
    exists: (rootPath, relPath) => {
      try {
        return fs.existsSync(`${rootPath.replace(/[/\\]+$/, '')}/${relPath}`);
      } catch {
        return false;
      }
    },
  });

/** Stop any active watch (idempotent). */
const stopWatch = (): void => {
  if (watcher) {
    watcher.stop();
    watcher = null;
  }
};

/** Start watching a workspace; on each debounced burst, fire matching hooks. */
const startWatch = async (rootPath: string): Promise<void> => {
  stopWatch();
  watcher = buildWatcher();
  watcher.start(rootPath, (event) => {
    void (async () => {
      const hooks = await storeFor(rootPath).list();
      const firings = computeHookFirings(hooks, event);
      for (const firing of firings) {
        ideHookChannels.fired.emit({ firing });
        void storeFor(rootPath).patch(firing.hook.id, { lastRunAt: Date.now() });
      }
    })();
  });
};

/**
 * Register the IDE-hook IPC handlers. Idempotent. Intended to be called once
 * during Main-process bootstrap.
 */
export function registerIdeHookBridge(): void {
  ideHookChannels.list.provider(async (req): Promise<IdeHookResult<IdeHook[]>> => {
    try {
      return { ok: true, data: await storeFor(req.rootPath).list() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideHookChannels.save.provider(async (req): Promise<IdeHookResult<IdeHook>> => {
    try {
      return { ok: true, data: await storeFor(req.rootPath).save(req.hook) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideHookChannels.remove.provider(async (req): Promise<IdeHookResult<IdeHook[]>> => {
    try {
      return { ok: true, data: await storeFor(req.rootPath).remove(req.id) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideHookChannels.run.provider(async (req): Promise<IdeHookResult<IdeHookFireRequest | null>> => {
    try {
      const hook = await storeFor(req.rootPath).get(req.id);
      if (!hook) return { ok: true, data: null };
      const firing = manualFiring(hook, req.rootPath);
      if (firing) void storeFor(req.rootPath).patch(hook.id, { lastRunAt: Date.now() });
      return { ok: true, data: firing };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideHookChannels.watchStart.provider(async (req): Promise<IdeHookResult<void>> => {
    try {
      await startWatch(req.rootPath);
      return { ok: true, data: undefined };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideHookChannels.watchStop.provider(async (_req): Promise<IdeHookResult<void>> => {
    try {
      stopWatch();
      return { ok: true, data: undefined };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
