/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type definitions for the System Insight feature (Settings › Quan sát).
 *
 * Two data planes:
 * - {@link StaticSystemInfo} — rarely-changing host facts read once at startup
 *   and on an explicit user refresh (OS, CPU model, total RAM, GPU, disks,
 *   network interfaces, versions). Cheap to render, expensive-ish to read, so it
 *   is NOT sampled on a timer.
 * - {@link LiveSystemMetrics} — fast-changing measurements sampled on a short
 *   interval and pushed to the renderer (CPU %, RAM usage, load average, uptime,
 *   per-process metrics, battery state).
 *
 * A {@link SystemSnapshot} bundles both planes plus the recent time-series so a
 * single read (e.g. by the Agent-plane MCP tool) is self-describing.
 *
 * This module contains types only (no runtime behaviour) so it can be imported
 * safely by Main-process services and, type-only, by the renderer UI and the
 * standalone MCP server without dragging in Node/Electron dependencies.
 */

/** Operating-system identity. */
export type OsInfo = {
  /** `process.platform` value, e.g. `win32`, `darwin`, `linux`. */
  platform: string;
  /** Human OS name from `os.type()`, e.g. `Windows_NT`, `Darwin`, `Linux`. */
  type: string;
  /** Kernel release string from `os.release()`. */
  release: string;
  /** Friendly OS version from `os.version()` when available. */
  version: string;
  /** CPU architecture from `os.arch()`, e.g. `x64`, `arm64`. */
  arch: string;
  /** Machine hostname from `os.hostname()`. */
  hostname: string;
  /** Logged-in username from `os.userInfo().username` (best-effort). */
  username: string;
};

/** Processor identity (static portion; live load lives in {@link CpuMetrics}). */
export type CpuInfo = {
  /** Model string from the first logical core, e.g. `Apple M2`, `Intel...`. */
  model: string;
  /** Number of logical cores (`os.cpus().length`). */
  logicalCores: number;
  /** Nominal clock speed in MHz from the first core (0 when unavailable). */
  speedMHz: number;
};

/** A single GPU device as reported by Electron `app.getGPUInfo('complete')`. */
export type GpuDevice = {
  /** Vendor name or numeric vendor id rendered as string. */
  vendor: string;
  /** Device/model name or numeric device id rendered as string. */
  model: string;
  /** Driver version string when present. */
  driverVersion: string;
  /** Whether this device is flagged as the active/primary GPU. */
  active: boolean;
};

/** Free/total space for one mounted volume (best-effort via `fs.statfs`). */
export type DiskInfo = {
  /** Filesystem path that was probed (e.g. the user's home directory). */
  mount: string;
  /** Total capacity in MB (0 when the read failed). */
  totalMB: number;
  /** Free space in MB available to an unprivileged user (0 on failure). */
  freeMB: number;
};

/** One network interface and its non-internal addresses. */
export type NetworkInterfaceInfo = {
  /** Interface name (e.g. `Ethernet`, `en0`, `wlan0`). */
  name: string;
  /** Hardware (MAC) address; empty string when unavailable. */
  mac: string;
  /** IPv4/IPv6 addresses bound to the interface (internal ones excluded). */
  addresses: string[];
};

/** Runtime/build versions of the embedding stack. */
export type RuntimeVersions = {
  /** AionUi app version (`app.getVersion()`). */
  app: string;
  /** Electron version (`process.versions.electron`). */
  electron: string;
  /** Chromium version (`process.versions.chrome`). */
  chrome: string;
  /** Node.js version (`process.versions.node`). */
  node: string;
  /** V8 engine version (`process.versions.v8`). */
  v8: string;
};

/**
 * Rarely-changing host facts. Read once at startup and re-read on an explicit
 * user refresh (the "Refresh" button) — never sampled on a timer.
 */
export type StaticSystemInfo = {
  /** Unix-ms timestamp when this profile was probed. */
  probedAt: number;
  os: OsInfo;
  cpu: CpuInfo;
  /** Total physical RAM in MB. */
  totalMemoryMB: number;
  /** Detected GPU devices (empty when Electron GPU info is unavailable). */
  gpus: GpuDevice[];
  /** Probed volumes (best-effort; may be a single entry). */
  disks: DiskInfo[];
  /** Network interfaces with their external addresses. */
  network: NetworkInterfaceInfo[];
  versions: RuntimeVersions;
};

/** Aggregate + per-core CPU utilisation, all as 0–100 percentages. */
export type CpuMetrics = {
  /** Overall CPU utilisation across all cores (0–100). */
  overallPercent: number;
  /** Per-core utilisation (0–100), index-aligned with `os.cpus()`. */
  perCorePercent: number[];
};

/** Physical-memory utilisation snapshot. */
export type MemoryMetrics = {
  /** Total physical RAM in MB. */
  totalMB: number;
  /** Used physical RAM in MB (`total - free`). */
  usedMB: number;
  /** Free physical RAM in MB. */
  freeMB: number;
  /** Used RAM as a 0–100 percentage. */
  usedPercent: number;
};

/**
 * Per-process metric derived from Electron `app.getAppMetrics()`.
 *
 * Covers the app's own child processes (browser/main, renderers, GPU, utility,
 * spawned tools). `cpuPercent` is the share of a single core (can exceed 100 on
 * multi-threaded processes, matching Chromium's accounting).
 */
export type ProcessMetric = {
  /** OS process id. */
  pid: number;
  /** Electron process type (`Browser`, `Tab`, `GPU`, `Utility`, ...). */
  type: string;
  /** Best-effort human name for the process (service/frame name when known). */
  name: string;
  /** CPU usage as a percentage of one core. */
  cpuPercent: number;
  /** Working-set (resident) memory in MB. */
  memoryMB: number;
  /**
   * Current OS scheduling priority (nice value) when readable, else `null`.
   * Lower is higher priority (see {@link ProcessPriorityLevel}).
   */
  priority: number | null;
};

/** Battery / power state (best-effort; desktop machines report `onBattery=false`). */
export type PowerMetrics = {
  /** Whether the machine is currently running on battery power. */
  onBattery: boolean;
};

/**
 * Fast-changing measurements sampled on a short interval and pushed to the
 * renderer. Every field is "right now" — no history (see {@link MetricSample}).
 */
export type LiveSystemMetrics = {
  /** Unix-ms timestamp when this sample was taken. */
  sampledAt: number;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  /** 1/5/15-minute load averages (`os.loadavg()`; `[0,0,0]` on Windows). */
  loadAvg: [number, number, number];
  /** System uptime in seconds (`os.uptime()`). */
  uptimeSec: number;
  /** Top per-process metrics, sorted by CPU descending (capped). */
  processes: ProcessMetric[];
  power: PowerMetrics;
};

/**
 * One point in the rolling time-series kept for sparklines. Intentionally tiny
 * (just the headline aggregates) so the buffer stays cheap to hold and serialise.
 */
export type MetricSample = {
  /** Unix-ms timestamp of the sample. */
  t: number;
  /** Overall CPU utilisation (0–100). */
  cpu: number;
  /** Memory utilisation (0–100). */
  mem: number;
};

/**
 * A complete, self-describing snapshot: static profile + latest live metrics +
 * the recent rolling history. This is what the snapshot file holds and what the
 * Agent-plane MCP tool returns.
 */
export type SystemSnapshot = {
  static: StaticSystemInfo;
  live: LiveSystemMetrics;
  /** Oldest-to-newest rolling history for sparklines. */
  history: MetricSample[];
};

/**
 * User-selectable process priority levels, mapped to `os.constants.priority`
 * nice values. Lower nice = higher scheduling priority.
 */
export type ProcessPriorityLevel = 'high' | 'aboveNormal' | 'normal' | 'belowNormal' | 'low';

/** Result of a {@link ProcessPriorityLevel} change request. */
export type SetPriorityResult = {
  /** Whether the OS accepted the priority change. */
  ok: boolean;
  /** The pid that was targeted. */
  pid: number;
  /** The level that was requested. */
  level: ProcessPriorityLevel;
  /** Error message when `ok` is false (e.g. insufficient privileges). */
  error?: string;
};
