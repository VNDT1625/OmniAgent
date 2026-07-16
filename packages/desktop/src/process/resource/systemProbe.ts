/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * System probe for the ResourceCoordinator (Requirement 5 — anti-lag resource
 * management, criterion 5.1).
 *
 * Reads the static profile of the host machine once at startup — total RAM,
 * logical CPU core count, presence of a discrete GPU, and free disk space — and
 * returns it as a {@link MachineProfile}. `balancePolicy` later uses this profile
 * to derive the suggested preset (saver / balanced / performance).
 *
 * ## Dependency strategy
 *
 * RAM and CPU come from Node's built-in `os` module (`os.totalmem`, `os.cpus`),
 * which is portable and always available in the Main process.
 *
 * The design (`design.md`, Yêu cầu 5) names the `systeminformation` package for
 * GPU and disk reads. However, `systeminformation` is **not** a declared
 * dependency of this project — it only appears in the lockfile as a transitive
 * dependency of `@office-ai/aioncli-core`, so importing it directly here would
 * rely on an undeclared package. To avoid silently adding a new dependency, this
 * module instead reads what it can from Node built-ins:
 *
 * - **Free disk space** is read with `fs.statfs` (Node ≥ 18.15) on the relevant
 *   volume (the user's home directory by default). This is a best-effort,
 *   dependency-free read.
 * - **Discrete GPU presence** is read via Electron's own `app.getGPUInfo`
 *   (see `gpuProbe.ts`), so no new dependency is added. It degrades to `false`
 *   whenever Electron is unavailable (e.g. under plain Node in tests). A test
 *   can still override {@link SystemProbeDeps.getHasDiscreteGPU} for
 *   determinism.
 *
 * ## Testability
 *
 * Every system read is injected via {@link SystemProbeDeps} so tests can supply
 * deterministic values without touching the real machine. {@link createSystemProbe}
 * accepts a partial override (mock only the deps a test cares about) and merges
 * it over {@link defaultSystemProbeDeps}. {@link probeSystem} is the convenience
 * default instance backed entirely by real `os`/`fs` reads.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import { detectDiscreteGpu } from './gpuProbe';
import type { MachineProfile } from './leaseTypes';

/** Number of bytes in one megabyte (MiB) used for byte → MB conversions. */
const BYTES_PER_MB = 1024 * 1024;

/**
 * Convert a byte count to whole megabytes (rounded). Negative or non-finite
 * inputs are clamped to `0` so a probe failure never yields a nonsensical
 * (negative / NaN) profile value.
 */
const bytesToMB = (bytes: number): number => {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round(bytes / BYTES_PER_MB);
};

/**
 * The set of low-level system reads the probe depends on. Declared explicitly
 * and injected so the system-reading layer can be fully mocked in tests.
 *
 * Each member maps to a single source of truth:
 * - `getTotalMemBytes`  → total physical RAM in bytes (`os.totalmem`).
 * - `getCpuCoreCount`   → number of logical CPU cores (`os.cpus().length`).
 * - `getHasDiscreteGPU` → whether a discrete GPU is present (async; allows a
 *   `systeminformation`-backed override later).
 * - `getFreeDiskBytes`  → free disk space in bytes on the relevant volume
 *   (async; `fs.statfs` by default).
 */
export type SystemProbeDeps = {
  /** Total physical RAM in bytes. */
  getTotalMemBytes: () => number;
  /** Number of logical CPU cores. */
  getCpuCoreCount: () => number;
  /** Resolve whether a discrete GPU is present. */
  getHasDiscreteGPU: () => Promise<boolean>;
  /** Resolve free disk space (bytes) on the relevant volume. */
  getFreeDiskBytes: () => Promise<number>;
};

/**
 * Best-effort free-disk read using Node's `fs.statfs` on the given path.
 *
 * Returns `0` (rather than throwing) if `statfs` is unavailable or fails, so a
 * probe failure degrades gracefully to a conservative profile. Free bytes are
 * computed as `bsize * bavail` (blocks available to an unprivileged user).
 */
const readFreeDiskBytes = async (probePath: string): Promise<number> => {
  try {
    const stats = await fs.promises.statfs(probePath);
    const free = Number(stats.bsize) * Number(stats.bavail);
    return Number.isFinite(free) && free > 0 ? free : 0;
  } catch (error) {
    console.warn('[Resource] Failed to read free disk space; defaulting to 0 MB:', error);
    return 0;
  }
};

/**
 * Default dependency implementation backed entirely by Node built-ins
 * (`os` + `fs`) plus Electron's own `app.getGPUInfo` for discrete-GPU detection.
 * No third-party package is imported.
 *
 * GPU detection uses {@link detectDiscreteGpu} (Electron `getGPUInfo`), which
 * degrades to `false` whenever Electron is unavailable (e.g. under plain Node in
 * tests), so the probe never throws and tests stay deterministic by overriding
 * `getHasDiscreteGPU`.
 */
export const defaultSystemProbeDeps: SystemProbeDeps = {
  getTotalMemBytes: () => os.totalmem(),
  getCpuCoreCount: () => os.cpus().length,
  getHasDiscreteGPU: () => detectDiscreteGpu(),
  getFreeDiskBytes: () => readFreeDiskBytes(os.homedir()),
};

/**
 * Create a system probe from the given (optional) dependency overrides.
 *
 * Any deps not supplied fall back to {@link defaultSystemProbeDeps}, so a test
 * can override just the reads it cares about (e.g. only `getHasDiscreteGPU`).
 *
 * @param deps Partial overrides for the system reads. Omit for the real probe.
 * @returns An async function that reads the host machine and resolves a
 *   {@link MachineProfile}.
 */
export const createSystemProbe = (deps?: Partial<SystemProbeDeps>): (() => Promise<MachineProfile>) => {
  const resolved: SystemProbeDeps = { ...defaultSystemProbeDeps, ...deps };

  return async (): Promise<MachineProfile> => {
    const [hasDiscreteGPU, freeDiskBytes] = await Promise.all([
      resolved.getHasDiscreteGPU(),
      resolved.getFreeDiskBytes(),
    ]);

    return {
      totalMemMB: bytesToMB(resolved.getTotalMemBytes()),
      cpuCores: Math.max(0, Math.trunc(resolved.getCpuCoreCount())),
      hasDiscreteGPU,
      freeDiskMB: bytesToMB(freeDiskBytes),
    };
  };
};

/**
 * Convenience default probe instance backed by real `os`/`fs` reads.
 *
 * Reads the host machine and resolves its {@link MachineProfile}. Equivalent to
 * `createSystemProbe()()` but exported as a ready-to-call function for callers
 * (e.g. the ResourceCoordinator startup path) that do not need to inject deps.
 */
export const probeSystem: () => Promise<MachineProfile> = createSystemProbe();
