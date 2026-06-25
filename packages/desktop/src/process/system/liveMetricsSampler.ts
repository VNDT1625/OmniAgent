/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live system-metrics sampler for the System Insight feature.
 *
 * Produces a {@link LiveSystemMetrics} reading on demand: aggregate + per-core
 * CPU utilisation, physical-memory usage, load average, uptime, per-process
 * metrics (from Electron `app.getAppMetrics()`) and battery state. CPU
 * utilisation is computed from the delta of `os.cpus()` busy/idle times between
 * consecutive samples, so a sampler instance is stateful and should be reused.
 *
 * Uses only Node built-ins (`os`) plus Electron (`app.getAppMetrics`,
 * `powerMonitor`) — no third-party dependency. Every external read is injected
 * via {@link LiveSamplerDeps} for deterministic unit testing.
 *
 * Process boundary: Main-process (Node.js / Electron) module — no DOM APIs.
 */

import * as os from 'node:os';
import type { LiveSystemMetrics, ProcessMetric } from './systemInfoTypes';

/** Bytes/KB in one MB for unit conversions. */
const KB_PER_MB = 1024;

/** Snapshot of one core's cumulative CPU times (ms) from `os.cpus()`. */
type CpuTimesSnapshot = { idle: number; total: number };

/** Raw Electron per-process metric shape (subset we consume). */
type RawAppMetric = {
  pid: number;
  type?: string;
  name?: string;
  serviceName?: string;
  cpu?: { percentCPUUsage?: number };
  memory?: { workingSetSize?: number };
};

/**
 * External reads the sampler depends on, injected for testability.
 */
export type LiveSamplerDeps = {
  /** Per-core cumulative CPU times (defaults to `os.cpus()`). */
  getCpus: () => os.CpuInfo[];
  /** Total physical RAM in bytes (`os.totalmem`). */
  getTotalMemBytes: () => number;
  /** Free physical RAM in bytes (`os.freemem`). */
  getFreeMemBytes: () => number;
  /** 1/5/15-minute load averages (`os.loadavg`). */
  getLoadAvg: () => number[];
  /** System uptime in seconds (`os.uptime`). */
  getUptimeSec: () => number;
  /** Electron per-process metrics (`app.getAppMetrics`). */
  getAppMetrics: () => RawAppMetric[];
  /** OS scheduling priority (nice) for a pid, or `null` when unreadable. */
  getPriority: (pid: number) => number | null;
  /** Whether the machine is on battery power (`powerMonitor.isOnBatteryPower`). */
  isOnBattery: () => boolean;
};

/** Build the default deps backed by real `os`/Electron reads (Electron loaded lazily). */
export const defaultLiveSamplerDeps: LiveSamplerDeps = {
  getCpus: () => os.cpus(),
  getTotalMemBytes: () => os.totalmem(),
  getFreeMemBytes: () => os.freemem(),
  getLoadAvg: () => os.loadavg(),
  getUptimeSec: () => os.uptime(),
  getAppMetrics: () => {
    try {
      const { app } = require('electron') as typeof import('electron');
      return app.getAppMetrics() as unknown as RawAppMetric[];
    } catch {
      return [];
    }
  },
  getPriority: (pid: number) => {
    try {
      return os.getPriority(pid);
    } catch {
      return null;
    }
  },
  isOnBattery: () => {
    try {
      const { powerMonitor } = require('electron') as typeof import('electron');
      return powerMonitor.isOnBatteryPower();
    } catch {
      return false;
    }
  },
};

/** Reduce one `os.cpus()` core entry to its idle + total cumulative times. */
const toTimesSnapshot = (cpu: os.CpuInfo): CpuTimesSnapshot => {
  const { user, nice, sys, idle, irq } = cpu.times;
  return { idle, total: user + nice + sys + idle + irq };
};

/** Compute a 0–100 utilisation from the delta of two cumulative snapshots. */
const utilisationFromDelta = (prev: CpuTimesSnapshot, next: CpuTimesSnapshot): number => {
  const idleDelta = next.idle - prev.idle;
  const totalDelta = next.total - prev.total;
  if (totalDelta <= 0) return 0;
  const used = 1 - idleDelta / totalDelta;
  return Math.min(100, Math.max(0, Math.round(used * 100)));
};

/** A readable per-process label, preferring the service/frame name when present. */
const processName = (metric: RawAppMetric): string => {
  if (metric.name && metric.name.length > 0) return metric.name;
  if (metric.serviceName && metric.serviceName.length > 0) return metric.serviceName;
  return metric.type ?? 'process';
};

/**
 * A stateful live sampler. Hold one instance and call {@link LiveSampler.sample}
 * repeatedly; CPU utilisation reflects the interval between successive calls.
 */
export type LiveSampler = {
  /** Take a reading. The first reading returns 0% CPU (no prior delta). */
  sample: () => LiveSystemMetrics;
};

/**
 * Create a stateful live sampler.
 *
 * The constructor seeds the previous CPU snapshot so the first {@link LiveSampler.sample}
 * call has a baseline; that first call therefore reports ~0% until a real
 * interval has elapsed between two calls.
 *
 * @param deps Partial overrides for the external reads (real reads otherwise).
 */
export const createLiveSampler = (deps?: Partial<LiveSamplerDeps>): LiveSampler => {
  const resolved: LiveSamplerDeps = { ...defaultLiveSamplerDeps, ...deps };
  let prevPerCore: CpuTimesSnapshot[] = resolved.getCpus().map(toTimesSnapshot);

  const sample = (): LiveSystemMetrics => {
    const cpus = resolved.getCpus();
    const nextPerCore = cpus.map(toTimesSnapshot);

    // Per-core utilisation from the delta against the previous snapshot. If the
    // core count changed (rare), fall back to a zero baseline for safety.
    const perCorePercent = nextPerCore.map((next, index) => {
      const prev = prevPerCore[index] ?? next;
      return utilisationFromDelta(prev, next);
    });
    prevPerCore = nextPerCore;

    const overallPercent =
      perCorePercent.length > 0
        ? Math.round(perCorePercent.reduce((sum, value) => sum + value, 0) / perCorePercent.length)
        : 0;

    const totalBytes = resolved.getTotalMemBytes();
    const freeBytes = resolved.getFreeMemBytes();
    const totalMB = Math.round(totalBytes / (KB_PER_MB * KB_PER_MB));
    const freeMB = Math.round(freeBytes / (KB_PER_MB * KB_PER_MB));
    const usedMB = Math.max(0, totalMB - freeMB);
    const usedPercent = totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0;

    const processes: ProcessMetric[] = resolved
      .getAppMetrics()
      .map((metric): ProcessMetric => ({
        pid: metric.pid,
        type: metric.type ?? 'unknown',
        name: processName(metric),
        cpuPercent: Math.round((metric.cpu?.percentCPUUsage ?? 0) * 10) / 10,
        memoryMB: Math.round((metric.memory?.workingSetSize ?? 0) / KB_PER_MB),
        priority: resolved.getPriority(metric.pid),
      }))
      .sort((a, b) => b.cpuPercent - a.cpuPercent);

    const load = resolved.getLoadAvg();

    return {
      sampledAt: Date.now(),
      cpu: { overallPercent, perCorePercent },
      memory: { totalMB, usedMB, freeMB, usedPercent },
      loadAvg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
      uptimeSec: Math.round(resolved.getUptimeSec()),
      processes,
      power: { onBattery: resolved.isOnBattery() },
    };
  };

  return { sample };
};
