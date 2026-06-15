/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Static system-information probe for the System Insight feature.
 *
 * Reads the rarely-changing host profile — OS identity, CPU model, total RAM,
 * GPU devices, disk capacity, network interfaces and runtime versions — using
 * only Node built-ins (`os`, `fs`) plus Electron's `app` for GPU info and the
 * app version. No third-party dependency is added (mirrors the dependency
 * strategy documented in `process/resource/systemProbe.ts`).
 *
 * Every external read is injected via {@link StaticProbeDeps} so the probe can
 * be unit-tested deterministically without touching the real machine or
 * requiring an Electron runtime.
 *
 * Process boundary: Main-process (Node.js / Electron) module — no DOM APIs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import type { DiskInfo, GpuDevice, NetworkInterfaceInfo, StaticSystemInfo } from './systemInfoTypes';

/** Bytes in one MB, used for byte → MB conversions. */
const BYTES_PER_MB = 1024 * 1024;

/** Convert a byte count to whole MB; clamps non-finite/negative inputs to 0. */
const bytesToMB = (bytes: number): number => {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round(bytes / BYTES_PER_MB);
};

/** Known PCI vendor ids → readable names for GPU labelling. */
const GPU_VENDOR_NAMES: Record<number, string> = {
  0x10de: 'NVIDIA',
  0x1002: 'AMD',
  0x8086: 'Intel',
  0x106b: 'Apple',
  0x5143: 'Qualcomm',
  0x1414: 'Microsoft',
};

/**
 * The external reads the static probe depends on. Injected so tests can supply
 * deterministic values and so the probe never hard-requires Electron.
 */
export type StaticProbeDeps = {
  /** Resolve the raw Electron `app.getGPUInfo('complete')` payload. */
  getGpuInfo: () => Promise<unknown>;
  /** Free + total bytes for a probe path (best-effort `fs.statfs`). */
  getDiskInfo: (probePath: string) => Promise<{ totalBytes: number; freeBytes: number }>;
  /** AionUi application version string. */
  getAppVersion: () => string;
  /** Filesystem paths to probe for disk capacity. */
  diskProbePaths: () => string[];
};

/** Best-effort disk read via `fs.statfs`; returns zeroes (never throws) on failure. */
const readDiskInfo = async (probePath: string): Promise<{ totalBytes: number; freeBytes: number }> => {
  try {
    const stats = await fs.promises.statfs(probePath);
    const blockSize = Number(stats.bsize);
    const total = blockSize * Number(stats.blocks);
    const free = blockSize * Number(stats.bavail);
    return {
      totalBytes: Number.isFinite(total) && total > 0 ? total : 0,
      freeBytes: Number.isFinite(free) && free > 0 ? free : 0,
    };
  } catch (error) {
    console.warn('[SystemInfo] Failed to read disk info for', probePath, error);
    return { totalBytes: 0, freeBytes: 0 };
  }
};

/**
 * Default dependency implementation backed by Node built-ins + Electron.
 *
 * GPU info and the app version come from Electron's `app`; importing it lazily
 * (inside the closures) means the module can still be imported under plain Node
 * (e.g. in tests) without Electron present — the closures simply fall back.
 */
export const defaultStaticProbeDeps: StaticProbeDeps = {
  getGpuInfo: async () => {
    try {
      const { app } = require('electron') as typeof import('electron');
      return await app.getGPUInfo('complete');
    } catch {
      return null;
    }
  },
  getDiskInfo: readDiskInfo,
  getAppVersion: () => {
    try {
      const { app } = require('electron') as typeof import('electron');
      return app.getVersion();
    } catch {
      return 'unknown';
    }
  },
  diskProbePaths: () => [os.homedir()],
};

/** Render a numeric or string vendor/device id into a readable label. */
const labelId = (value: unknown, vendorMap?: Record<number, string>): string => {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (vendorMap && vendorMap[value]) return vendorMap[value];
    return `0x${value.toString(16)}`;
  }
  return '';
};

/**
 * Parse Electron's loosely-typed GPU payload into our {@link GpuDevice} list.
 *
 * The shape differs across platforms/Electron versions, so every field access
 * is defensive. Prefers a readable GL renderer string for the model when the
 * driver exposes one.
 */
export const parseGpuInfo = (raw: unknown): GpuDevice[] => {
  if (raw === null || typeof raw !== 'object') return [];
  const payload = raw as { gpuDevice?: unknown; auxAttributes?: { glRenderer?: unknown } };
  const devices = Array.isArray(payload.gpuDevice) ? payload.gpuDevice : [];
  const glRenderer = typeof payload.auxAttributes?.glRenderer === 'string' ? payload.auxAttributes.glRenderer : '';

  return devices
    .map((device): GpuDevice | null => {
      if (device === null || typeof device !== 'object') return null;
      const d = device as { vendorId?: unknown; deviceId?: unknown; active?: unknown; driverVersion?: unknown };
      const active = d.active === true;
      const vendor = labelId(d.vendorId, GPU_VENDOR_NAMES);
      const deviceLabel = labelId(d.deviceId);
      // The active device gets the readable GL renderer name when present.
      const model = active && glRenderer ? glRenderer : deviceLabel || glRenderer || 'GPU';
      return {
        vendor: vendor || 'Unknown',
        model,
        driverVersion: typeof d.driverVersion === 'string' ? d.driverVersion : '',
        active,
      };
    })
    .filter((device): device is GpuDevice => device !== null);
};

/** Collect non-internal network interfaces with their addresses. */
const collectNetworkInterfaces = (): NetworkInterfaceInfo[] => {
  const result: NetworkInterfaceInfo[] = [];
  const interfaces = os.networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries) continue;
    const external = entries.filter((entry) => !entry.internal);
    if (external.length === 0) continue;
    result.push({
      name,
      mac: external[0]?.mac ?? '',
      addresses: external.map((entry) => entry.address),
    });
  }
  return result;
};

/**
 * Create a static probe from the given (optional) dependency overrides. Any dep
 * not supplied falls back to {@link defaultStaticProbeDeps}.
 *
 * @returns An async function that reads the host and resolves a
 *   {@link StaticSystemInfo}.
 */
export const createStaticProbe = (deps?: Partial<StaticProbeDeps>): (() => Promise<StaticSystemInfo>) => {
  const resolved: StaticProbeDeps = { ...defaultStaticProbeDeps, ...deps };

  return async (): Promise<StaticSystemInfo> => {
    const cpus = os.cpus();
    const probePaths = resolved.diskProbePaths();

    const [gpuRaw, ...diskReads] = await Promise.all([
      resolved.getGpuInfo(),
      ...probePaths.map((probePath) => resolved.getDiskInfo(probePath)),
    ]);

    const disks: DiskInfo[] = probePaths.map((mount, index) => ({
      mount,
      totalMB: bytesToMB(diskReads[index]?.totalBytes ?? 0),
      freeMB: bytesToMB(diskReads[index]?.freeBytes ?? 0),
    }));

    let username = '';
    try {
      username = os.userInfo().username;
    } catch {
      username = '';
    }

    return {
      probedAt: Date.now(),
      os: {
        platform: process.platform,
        type: os.type(),
        release: os.release(),
        version: typeof os.version === 'function' ? os.version() : '',
        arch: os.arch(),
        hostname: os.hostname(),
        username,
      },
      cpu: {
        model: cpus[0]?.model?.trim() ?? 'Unknown CPU',
        logicalCores: cpus.length,
        speedMHz: cpus[0]?.speed ?? 0,
      },
      totalMemoryMB: bytesToMB(os.totalmem()),
      gpus: parseGpuInfo(gpuRaw),
      disks,
      network: collectNetworkInterfaces(),
      versions: {
        app: resolved.getAppVersion(),
        electron: process.versions.electron ?? '',
        chrome: process.versions.chrome ?? '',
        node: process.versions.node ?? '',
        v8: process.versions.v8 ?? '',
      },
    };
  };
};

/** Convenience default probe instance backed by real reads. */
export const probeStaticSystemInfo: () => Promise<StaticSystemInfo> = createStaticProbe();
