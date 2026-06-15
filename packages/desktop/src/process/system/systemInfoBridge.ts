/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * System Insight IPC bridge — exposes the Main-process {@link SystemInfoService}
 * to the renderer Quan sát page (Settings › Quan sát).
 *
 * Like `resourceBridge`, this is an Electron-native bridge (not an aioncore HTTP
 * route): the service is a Main-process singleton that owns the sampling timer
 * and per-process priority control, so its surface is reached through the same
 * `ipcBridge` provider/emitter channels used by the other native bridges.
 *
 * Channels (defined in `common/adapter/ipcBridge.ts` under `systemInfo`):
 * - `getStaticInfo` / `refreshStatic` / `getSnapshot` — read the host profile.
 * - `setProcessPriority` — nudge a live process's OS scheduling priority.
 * - `startStream` / `stopStream` — ref-counted control of fast live streaming so
 *   the timer only runs fast while the page is open.
 * - `metricsChanged` — main → renderer push forwarding every live sample.
 *
 * The global bootstrap (`process/bridge/index.ts`) calls {@link registerSystemInfoBridge}
 * once during Main-process startup and starts the service.
 *
 * Process boundary: Main-process (Node.js / Electron) module — no DOM APIs.
 */

import { ipcBridge } from '@/common';
import { getSystemInfoService } from './systemInfoService';

/** Unsubscribe handle for the service's metrics subscription. */
let unsubscribeMetrics: (() => void) | undefined;

/**
 * Register the System Insight IPC handlers and wire the live metrics push.
 *
 * Idempotent: a repeated call replaces the previous metrics subscription. Does
 * not start the service itself — the bootstrap awaits `service.start()` so the
 * static profile is probed before the first renderer read.
 */
export function registerSystemInfoBridge(): void {
  const service = getSystemInfoService();

  ipcBridge.systemInfo.getStaticInfo.provider(() => Promise.resolve(service.getStaticInfo()));

  ipcBridge.systemInfo.refreshStatic.provider(() => service.refreshStatic());

  ipcBridge.systemInfo.getSnapshot.provider(() => Promise.resolve(service.getSnapshot()));

  ipcBridge.systemInfo.setProcessPriority.provider(({ pid, level }) =>
    Promise.resolve(service.setProcessPriority(pid, level))
  );

  // Ref-counted streaming: the renderer calls these on mount/unmount so the
  // sampler only runs at the fast cadence while the page is visible.
  ipcBridge.systemInfo.startStream.provider(() => {
    service.startStream();
    return Promise.resolve();
  });

  ipcBridge.systemInfo.stopStream.provider(() => {
    service.stopStream();
    return Promise.resolve();
  });

  // Forward every live sample to the renderer (only emitted while streaming).
  unsubscribeMetrics?.();
  unsubscribeMetrics = service.onMetrics((metrics) => {
    ipcBridge.systemInfo.metricsChanged.emit(metrics);
  });
}

/**
 * Detach the live metrics push subscription and stop the service. Useful for
 * deterministic teardown (tests, hot-reload).
 */
export function disposeSystemInfoBridge(): void {
  unsubscribeMetrics?.();
  unsubscribeMetrics = undefined;
}
