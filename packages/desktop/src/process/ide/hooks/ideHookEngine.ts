/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IDE Agent Hooks engine — turns a debounced {@link RepoChangeEvent} from the
 * repo watcher into the set of concrete hook firings to dispatch.
 *
 * Pure decision logic (no `fs`, no IPC): given the current hook list and a
 * change batch, it returns one {@link IdeHookFireRequest} per (enabled hook ×
 * matching path), deduplicated so a hook with several matching files in one
 * burst fires once. The actual side effects (asking the agent / running a
 * command) are performed by the bridge layer, keeping this unit-testable.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { RepoChangeEvent } from '../understandTypes';
import type { IdeHook, IdeHookEvent, IdeHookFireRequest } from './ideHookTypes';
import { matchesAnyPattern } from './ideHookMatch';

/** Whether a hook is runnable: enabled and has the payload its action needs. */
export const isHookRunnable = (hook: IdeHook): boolean => {
  if (!hook.enabled) return false;
  if (hook.action === 'askAgent') return typeof hook.prompt === 'string' && hook.prompt.trim().length > 0;
  if (hook.action === 'runCommand') return typeof hook.command === 'string' && hook.command.trim().length > 0;
  return false;
};

/**
 * Compute the hook firings for a repo change batch.
 *
 * `changed` paths fire `fileSaved` AND `fileCreated` hooks (the watcher cannot
 * always distinguish a brand-new file from an edit, so both event types get a
 * chance to match; `removed` paths fire `fileDeleted` hooks). Each hook fires at
 * most once per batch, against the first path that matched it (so the agent
 * prompt / command gets a representative `relPath`).
 */
export const computeHookFirings = (hooks: readonly IdeHook[], event: RepoChangeEvent): IdeHookFireRequest[] => {
  const firings: IdeHookFireRequest[] = [];
  const firedHookIds = new Set<string>();

  const tryFire = (hook: IdeHook, relPath: string): void => {
    if (firedHookIds.has(hook.id)) return;
    if (!isHookRunnable(hook)) return;
    if (!matchesAnyPattern(relPath, hook.filePatterns)) return;
    firedHookIds.add(hook.id);
    firings.push({ hook, relPath, rootPath: event.rootPath });
  };

  // `changed` covers both saves and creations from the watcher's perspective.
  const changedEvents: IdeHookEvent[] = ['fileSaved', 'fileCreated'];
  for (const hook of hooks) {
    if (changedEvents.includes(hook.event)) {
      for (const relPath of event.changed) tryFire(hook, relPath);
    } else if (hook.event === 'fileDeleted') {
      for (const relPath of event.removed) tryFire(hook, relPath);
    }
  }

  return firings;
};

/** Build a fire request for a MANUALLY-triggered hook (no path filter applies). */
export const manualFiring = (hook: IdeHook, rootPath: string): IdeHookFireRequest | null => {
  if (!isHookRunnable(hook)) return null;
  return { hook, rootPath };
};
