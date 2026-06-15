/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resource Coordinator IPC bridge — exposes the Main-process
 * {@link IResourceCoordinator} to the renderer Resource Dashboard
 * (Requirement 5.2).
 *
 * This is an Electron-native bridge (not an aioncore HTTP route): the
 * coordinator is a Main-process singleton that owns the lease accounting and
 * the Tier B balancing loop, so its surface is reached through the same
 * `bridge.buildProvider` / `bridge.buildEmitter` channels used by the other
 * native bridges (window controls, webui, ...).
 *
 * Channels (defined in `common/adapter/ipcBridge.ts` under `resource`):
 * - `getState` / `setMode` / `setBudget` / `applyPreset` — invoke/handle. Each
 *   mutating call returns the freshly-computed {@link ResourceState} so the
 *   Dashboard can update immediately without waiting for the push event.
 * - `stateChanged` — a main → renderer push. We subscribe to the coordinator's
 *   `onStateChange` and forward every new {@link ResourceState} so the Dashboard
 *   live-updates as leases are granted/released and the budget self-balances.
 *
 * The global bootstrap (task 15.1) is responsible for calling
 * {@link registerResourceBridge} once during Main-process startup; this module
 * does not wire itself in.
 */

import { ipcBridge } from '@/common';
import { getResourceCoordinator } from '@process/resource/resourceCoordinator';

/**
 * Unsubscribe handle for the coordinator's `onStateChange` subscription. Kept at
 * module scope so a repeated {@link registerResourceBridge} call can detach the
 * previous subscription first and avoid double-emitting state updates.
 */
let unsubscribeStateChange: (() => void) | undefined;

/**
 * Register the Resource Coordinator IPC handlers and wire the live state push.
 *
 * Idempotent: calling it again re-registers the providers and replaces the
 * previous `onStateChange` subscription with a fresh one.
 *
 * Intended to be invoked once during Main-process bootstrap (task 15.1).
 */
export function registerResourceBridge(): void {
  const coordinator = getResourceCoordinator();

  // Read the current snapshot (budget, queue, adjustment reasons).
  ipcBridge.resource.getState.provider(() => Promise.resolve(coordinator.getState()));

  // Switch between 'detailed' (manual) and 'suggest' (self-balancing) modes,
  // returning the updated state for an immediate Dashboard refresh.
  ipcBridge.resource.setMode.provider(({ mode }) => {
    coordinator.setMode(mode);
    return Promise.resolve(coordinator.getState());
  });

  // Merge a partial budget edit (marks the preset as 'custom').
  ipcBridge.resource.setBudget.provider(({ budget }) => {
    coordinator.setBudget(budget);
    return Promise.resolve(coordinator.getState());
  });

  // Apply a built-in quick level (saver | balanced | performance).
  ipcBridge.resource.applyPreset.provider(({ preset }) => {
    coordinator.applyPreset(preset);
    return Promise.resolve(coordinator.getState());
  });

  // Replace any prior subscription, then push every new state to the renderer.
  unsubscribeStateChange?.();
  unsubscribeStateChange = coordinator.onStateChange((state) => {
    ipcBridge.resource.stateChanged.emit(state);
  });
}

/**
 * Detach the live state push subscription. Useful for deterministic teardown
 * (tests, hot-reload); the invoke/handle providers remain registered.
 */
export function disposeResourceBridge(): void {
  unsubscribeStateChange?.();
  unsubscribeStateChange = undefined;
}
