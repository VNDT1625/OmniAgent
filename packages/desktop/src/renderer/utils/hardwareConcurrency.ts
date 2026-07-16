/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hardware-aware concurrency helpers for the renderer.
 *
 * Several renderer-side fan-out loops (testing MCP servers in parallel, running
 * a "company" of sub-agents, etc.) historically used a fixed magic number for
 * how many things to run at once. On a 4-core laptop that over-subscribes the
 * CPU and makes the whole app lag; on a 16-core workstation it under-uses it.
 *
 * The renderer is a Chromium process, so it cannot use Node's `os` module, but
 * `navigator.hardwareConcurrency` exposes the logical core count. These helpers
 * derive a sensible parallelism from it, always clamped to a safe range so a
 * weird/missing value can never produce `0` or an absurd number.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

/** Fallback logical-core count when `navigator.hardwareConcurrency` is unavailable. */
const FALLBACK_CORES = 4;

/** Clamp `value` into the inclusive range `[min, max]`. */
const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/**
 * Read the host's logical CPU core count from `navigator.hardwareConcurrency`,
 * falling back to {@link FALLBACK_CORES} when it is missing or nonsensical
 * (e.g. in a non-browser test environment).
 *
 * @returns A positive whole number of logical cores.
 */
export const getLogicalCoreCount = (): number => {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
  if (typeof cores === 'number' && Number.isFinite(cores) && cores > 0) {
    return Math.floor(cores);
  }
  return FALLBACK_CORES;
};

/** Tunables for {@link recommendedConcurrency}. */
export type ConcurrencyOptions = {
  /** Lowest parallelism to ever return. Defaults to `1`. */
  min?: number;
  /** Highest parallelism to ever return. Defaults to `8`. */
  max?: number;
  /**
   * Fraction of logical cores to use (CPU-bound work wants < 1 so the UI thread
   * and other processes stay responsive). Defaults to `0.5`.
   */
  fraction?: number;
};

/**
 * Recommend how many tasks to run in parallel based on the host's core count.
 *
 * Uses a fraction of the logical cores (so the app never pins every core and
 * lags the machine), clamped into `[min, max]`. This replaces hardcoded magic
 * numbers in renderer fan-out loops so parallelism scales with the user's
 * actual laptop instead of being fixed.
 *
 * @example
 *   recommendedConcurrency()                 // 4-core → 2, 16-core → 8
 *   recommendedConcurrency({ max: 4 })       // capped at 4
 *   recommendedConcurrency({ fraction: 1 })  // use all cores (clamped to max)
 *
 * @param options Optional min/max/fraction overrides.
 * @returns A whole number of tasks to run concurrently, at least `min`.
 */
export const recommendedConcurrency = (options: ConcurrencyOptions = {}): number => {
  const min = options.min ?? 1;
  const max = options.max ?? 8;
  const fraction = options.fraction ?? 0.5;
  const scaled = Math.floor(getLogicalCoreCount() * fraction);
  return clamp(scaled, min, max);
};
