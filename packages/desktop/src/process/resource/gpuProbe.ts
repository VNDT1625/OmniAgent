/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Discrete-GPU detection for the ResourceCoordinator's system probe
 * (Requirement 5, criterion 5.1).
 *
 * The original {@link systemProbe} could not tell whether the host had a
 * discrete GPU, so it conservatively reported `false` — which meant
 * `suggestPreset` would (almost) never pick `performance`, even on a capable
 * gaming/workstation laptop. This module closes that gap using Electron's own
 * `app.getGPUInfo('basic')`, so NO new dependency is added (the design's
 * `systeminformation` package is still avoided).
 *
 * The classification heuristic ({@link hasDiscreteGpuFromDevices}) is a pure
 * function so it can be unit-tested without a live Electron app. The Electron
 * read ({@link detectDiscreteGpu}) imports `electron` lazily and degrades to
 * `false` on any failure (e.g. when running under plain Node in tests), so it is
 * always safe to call.
 */

/** PCI vendor id for NVIDIA (0x10DE). NVIDIA GPUs are effectively always discrete. */
const VENDOR_NVIDIA = 0x10de;

/** PCI vendor id for Intel (0x8086). Intel GPUs on consumer machines are integrated. */
const VENDOR_INTEL = 0x8086;

/** A single GPU device as reported by Electron's `app.getGPUInfo('basic')`. */
export type GpuDevice = {
  /** PCI vendor id (0 / undefined when the platform cannot report it). */
  vendorId?: number;
  /** PCI device id (unused by the heuristic, kept for completeness). */
  deviceId?: number;
};

/**
 * Decide whether a discrete GPU is present from the list of GPU devices.
 *
 * Heuristic (best-effort, dependency-free):
 * - **NVIDIA present** → discrete. NVIDIA does not ship integrated GPUs on the
 *   platforms this app targets, so any NVIDIA device implies a discrete card.
 * - **An Intel iGPU plus at least one other distinct vendor** → the second
 *   vendor (AMD / NVIDIA) is the discrete card alongside the Intel integrated
 *   one.
 * - **Two or more distinct GPU vendors** → a discrete GPU sits next to the
 *   integrated one.
 *
 * A lone AMD GPU is treated as integrated (an APU) rather than discrete, because
 * it cannot be distinguished from a desktop APU without a device-id database —
 * the conservative choice keeps modest machines on a lighter preset.
 *
 * @param devices GPU devices from `app.getGPUInfo('basic')`.
 * @returns Whether a discrete GPU is present.
 */
export const hasDiscreteGpuFromDevices = (devices: readonly GpuDevice[]): boolean => {
  const vendors = devices
    .map((device) => device.vendorId)
    .filter((id): id is number => typeof id === 'number' && id > 0);
  if (vendors.length === 0) return false;

  if (vendors.includes(VENDOR_NVIDIA)) return true;

  const uniqueVendors = new Set(vendors);
  if (uniqueVendors.has(VENDOR_INTEL) && uniqueVendors.size > 1) return true;

  return uniqueVendors.size > 1;
};

/** Shape of the subset of `getGPUInfo('basic')` we read. */
type BasicGpuInfo = { gpuDevice?: GpuDevice[] };

/**
 * Detect whether the host has a discrete GPU via Electron's `app.getGPUInfo`.
 *
 * Imports `electron` lazily so this module can be loaded under plain Node (e.g.
 * in unit tests) without dragging in the Electron runtime. Any failure — no
 * Electron, `getGPUInfo` unavailable, a rejected promise — degrades gracefully
 * to `false` (assume integrated only).
 *
 * @returns A promise resolving to whether a discrete GPU is present.
 */
export const detectDiscreteGpu = async (): Promise<boolean> => {
  try {
    const electron = (await import('electron')) as {
      app?: { getGPUInfo?: (level: 'basic' | 'complete') => Promise<unknown> };
    };
    const app = electron.app;
    if (!app || typeof app.getGPUInfo !== 'function') return false;
    const info = (await app.getGPUInfo('basic')) as BasicGpuInfo;
    const devices = Array.isArray(info?.gpuDevice) ? info.gpuDevice : [];
    return hasDiscreteGpuFromDevices(devices);
  } catch (error) {
    console.warn('[Resource] GPU probe failed; assuming integrated GPU only:', error);
    return false;
  }
};
