/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Balancing policy for the ResourceCoordinator (Requirement 5 — anti-lag
 * resource management). This module is the rule engine behind the first two of
 * the "three tiers" of balancing described in `design.md` (Yêu cầu 5):
 *
 * - **Tier A — initial assessment (bậc a, criterion 5.3 / 5.6):** given the
 *   static {@link MachineProfile} read by `systemProbe`, derive a *suggested*
 *   preset (`saver | balanced | performance`) and turn any preset into a
 *   concrete {@link ResourceBudget}.
 * - **Tier B — real-time self-adjust (bậc b, criteria 5.6 / 5.7):** given the
 *   current budget plus a live sample of resource pressure, decide whether to
 *   scale the budget down (machine under load) or back up (machine comfortable)
 *   and return a human-readable `reason`. Implements **hysteresis** (a dead-band
 *   between the scale-down and scale-up thresholds so it never flaps around a
 *   single point) and **rate limiting** (at most {@link MAX_ADJUSTMENTS_PER_WINDOW}
 *   adjustments per {@link RATE_LIMIT_WINDOW_MS}).
 *
 * Tier C (bậc c — AI deep analysis) lives in `balanceAdvisor.ts` and is out of
 * scope here.
 *
 * ## Purity
 *
 * Every function in this module is **pure**: it never reads the clock, the file
 * system, or the machine directly. The current time (`now`), the live resource
 * sample, and the recent-adjustment timestamps are all passed in as parameters.
 * This keeps the policy trivially unit-testable (subtask 1.5) and lets the
 * coordinator (subtask 1.6) own all the side effects (timers, probes, and
 * persistence via `appendBudgetAdjustment`).
 */

import type { ApplicablePreset, BudgetAdjustment, MachineProfile, ResourceBudget, TaskKind } from './leaseTypes';

/** Every {@link TaskKind}, in a stable order, for building per-kind records. */
const ALL_TASK_KINDS: readonly TaskKind[] = [
  'agent',
  'browser',
  'emulator',
  'windowsTest',
  'patchBuild',
  'ocr',
  'transcription',
  'docConvert',
  'semanticIndex',
];

/**
 * Task kinds whose concurrency scales with CPU core count. The remaining kinds
 * (`emulator`, `windowsTest`, `patchBuild`) are extremely heavy — a single
 * extra instance can swamp a machine — so they stay pinned to their preset base
 * regardless of how many cores are available.
 */
const CPU_SCALABLE_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>([
  'agent',
  'browser',
  'ocr',
  'transcription',
  'docConvert',
  'semanticIndex',
]);

/** Build a full `Record<TaskKind, number>` by evaluating `fn` for every kind. */
const buildConcurrency = (fn: (kind: TaskKind) => number): Record<TaskKind, number> => {
  const result = {} as Record<TaskKind, number>;
  for (const kind of ALL_TASK_KINDS) {
    result[kind] = fn(kind);
  }
  return result;
};

/** Clamp `value` into the inclusive range `[min, max]`. */
const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** Round to a non-negative whole number of MB (guards against NaN / negatives). */
const toWholeMB = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

// ---------------------------------------------------------------------------
// Tier A — initial assessment (preset definitions + suggestion)
// ---------------------------------------------------------------------------

/**
 * Core count treated as the "baseline" unit when scaling concurrency. A machine
 * with this many logical cores gets the preset's base concurrency (factor 1);
 * every additional multiple of this count raises the factor by one (capped per
 * preset by {@link PresetDefinition.maxCoreMultiplier}).
 */
export const BASELINE_CPU_CORES = 4;

/** Hard floor on RAM reserved for the user, so the machine never starves. */
export const MIN_RESERVE_FOR_USER_MB = 1024;

/** Hard floor on the heavy-task memory ceiling, so at least one task can run. */
export const MIN_HEAVY_MEMORY_MB = 512;

/**
 * Shape of a built-in preset before it is materialised against a concrete
 * machine. Memory limits are expressed as *fractions of total RAM* (so they
 * scale with the host), while concurrency starts from an explicit per-kind base
 * that may be multiplied for many-core machines.
 */
export type PresetDefinition = {
  /** Fraction of total RAM that may be dedicated to heavy tasks. */
  maxMemoryFraction: number;
  /** Fraction of total RAM kept free for the user. */
  reserveFraction: number;
  /** Upper bound on the CPU-core multiplier applied to scalable kinds. */
  maxCoreMultiplier: number;
  /** Base per-kind concurrency for a {@link BASELINE_CPU_CORES}-core machine. */
  baseConcurrent: Record<TaskKind, number>;
};

/**
 * The three built-in presets. `saver` is the most conservative (reserves the
 * most RAM, allows the fewest concurrent tasks, never scales up with cores);
 * `performance` is the most aggressive; `balanced` sits between them. Values are
 * monotonic across presets for every field, so a higher preset never grants
 * fewer resources than a lower one on the same machine.
 */
export const PRESET_DEFINITIONS: Record<ApplicablePreset, PresetDefinition> = {
  saver: {
    maxMemoryFraction: 0.3,
    reserveFraction: 0.5,
    maxCoreMultiplier: 1,
    baseConcurrent: {
      agent: 1,
      browser: 1,
      emulator: 1,
      windowsTest: 1,
      patchBuild: 1,
      ocr: 1,
      transcription: 1,
      docConvert: 1,
      semanticIndex: 1,
    },
  },
  balanced: {
    maxMemoryFraction: 0.55,
    reserveFraction: 0.35,
    maxCoreMultiplier: 2,
    baseConcurrent: {
      agent: 2,
      browser: 2,
      emulator: 1,
      windowsTest: 1,
      patchBuild: 1,
      ocr: 2,
      transcription: 2,
      docConvert: 2,
      semanticIndex: 2,
    },
  },
  performance: {
    maxMemoryFraction: 0.75,
    reserveFraction: 0.2,
    maxCoreMultiplier: 4,
    baseConcurrent: {
      agent: 4,
      browser: 4,
      emulator: 2,
      windowsTest: 2,
      patchBuild: 2,
      ocr: 3,
      transcription: 3,
      docConvert: 3,
      semanticIndex: 3,
    },
  },
};

/**
 * Materialise a preset into a concrete {@link ResourceBudget} for a given
 * machine (Tier A). Memory limits are derived from the machine's total RAM via
 * the preset's fractions (clamped to safe floors); concurrency starts from the
 * preset base and is multiplied for CPU-scalable kinds on many-core machines.
 *
 * @param preset  One of the built-in quick levels.
 * @param machine The static profile from `systemProbe`.
 * @returns The budget the coordinator should enforce for this preset + machine.
 */
export const presetBudget = (preset: ApplicablePreset, machine: MachineProfile): ResourceBudget => {
  const def = PRESET_DEFINITIONS[preset];
  const coreFactor = clamp(Math.floor(machine.cpuCores / BASELINE_CPU_CORES), 1, def.maxCoreMultiplier);

  return {
    maxConcurrent: buildConcurrency((kind) => {
      const base = def.baseConcurrent[kind];
      return CPU_SCALABLE_KINDS.has(kind) ? base * coreFactor : base;
    }),
    maxTotalMemoryMB: Math.max(MIN_HEAVY_MEMORY_MB, toWholeMB(machine.totalMemMB * def.maxMemoryFraction)),
    reserveForUserMB: Math.max(MIN_RESERVE_FOR_USER_MB, toWholeMB(machine.totalMemMB * def.reserveFraction)),
  };
};

/** Below this much total RAM the machine is always suggested `saver`. */
export const SUGGEST_SAVER_BELOW_MEM_MB = 8 * 1024;

/** Below this many CPU cores the machine is always suggested `saver`. */
export const SUGGEST_SAVER_BELOW_CORES = 4;

/** At/above this much total RAM the machine is eligible for `performance`. */
export const SUGGEST_PERFORMANCE_MIN_MEM_MB = 16 * 1024;

/** At/above this many CPU cores the machine is eligible for `performance`. */
export const SUGGEST_PERFORMANCE_MIN_CORES = 8;

/**
 * RAM at/above which a machine is treated as high-end enough for `performance`
 * even WITHOUT a discrete GPU (workstation laptops with a strong iGPU + lots of
 * RAM/cores). Paired with {@link SUGGEST_PERFORMANCE_NO_GPU_MIN_CORES}.
 */
export const SUGGEST_PERFORMANCE_NO_GPU_MIN_MEM_MB = 32 * 1024;

/** Core count at/above which `performance` is allowed without a discrete GPU. */
export const SUGGEST_PERFORMANCE_NO_GPU_MIN_CORES = 12;

/**
 * Derive the suggested preset from a machine profile (Tier A, criterion 5.3).
 *
 * - Low RAM **or** few cores → `saver` (stay light on modest hardware).
 * - High RAM **and** many cores **and** a discrete GPU → `performance`.
 * - Very high RAM **and** very many cores (even without a discrete GPU) →
 *   `performance`, so a strong integrated-GPU workstation is not held back.
 * - Everything in between → `balanced`.
 *
 * @param machine The static profile from `systemProbe`.
 * @returns The preset the coordinator should suggest by default.
 */
export const suggestPreset = (machine: MachineProfile): ApplicablePreset => {
  if (machine.totalMemMB < SUGGEST_SAVER_BELOW_MEM_MB || machine.cpuCores < SUGGEST_SAVER_BELOW_CORES) {
    return 'saver';
  }
  if (
    machine.hasDiscreteGPU &&
    machine.totalMemMB >= SUGGEST_PERFORMANCE_MIN_MEM_MB &&
    machine.cpuCores >= SUGGEST_PERFORMANCE_MIN_CORES
  ) {
    return 'performance';
  }
  if (
    machine.totalMemMB >= SUGGEST_PERFORMANCE_NO_GPU_MIN_MEM_MB &&
    machine.cpuCores >= SUGGEST_PERFORMANCE_NO_GPU_MIN_CORES
  ) {
    return 'performance';
  }
  return 'balanced';
};

// ---------------------------------------------------------------------------
// Tier B — real-time self-adjust (hysteresis + rate limiting)
// ---------------------------------------------------------------------------

/** Default interval (ms) at which the coordinator samples pressure (design: 5s). */
export const BALANCE_INTERVAL_MS = 5000;

/** Window over which automatic adjustments are rate-limited (criterion 5.7). */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** Maximum number of automatic adjustments allowed within {@link RATE_LIMIT_WINDOW_MS}. */
export const MAX_ADJUSTMENTS_PER_WINDOW = 3;

/**
 * Scale **down** when free RAM drops below this fraction of total RAM. Paired
 * with {@link SCALE_UP_FREE_MEM_FRACTION} to form the memory hysteresis band.
 */
export const SCALE_DOWN_FREE_MEM_FRACTION = 0.15;

/**
 * Scale **up** only when free RAM rises above this fraction of total RAM. The
 * gap up to {@link SCALE_DOWN_FREE_MEM_FRACTION} is the dead-band where nothing
 * happens — see {@link MEMORY_HYSTERESIS_DEAD_BAND}.
 */
export const SCALE_UP_FREE_MEM_FRACTION = 0.4;

/** Scale **down** when CPU load (fraction in [0, 1]) exceeds this. */
export const SCALE_DOWN_CPU_LOAD = 0.85;

/** Scale **up** only when CPU load (fraction in [0, 1]) is below this. */
export const SCALE_UP_CPU_LOAD = 0.5;

/**
 * Width of the free-RAM hysteresis dead-band: while the free-memory fraction sits
 * between the scale-down and scale-up thresholds, the policy makes no change.
 * This is what stops the budget oscillating around a single threshold.
 */
export const MEMORY_HYSTERESIS_DEAD_BAND = SCALE_UP_FREE_MEM_FRACTION - SCALE_DOWN_FREE_MEM_FRACTION;

/** Width of the CPU-load hysteresis dead-band (analogue of the memory band). */
export const CPU_HYSTERESIS_DEAD_BAND = SCALE_DOWN_CPU_LOAD - SCALE_UP_CPU_LOAD;

/** How many concurrency slots each scale step adds/removes per task kind. */
export const CONCURRENCY_STEP = 1;

/** Hard floor on per-kind concurrency; Tier B never tunes a kind below this. */
export const ABSOLUTE_MIN_CONCURRENT = 1;

/** A live sample of system pressure, taken by the coordinator each tick. */
export type ResourceSample = {
  /** Currently free system RAM (MB). */
  freeMemMB: number;
  /** Current CPU utilisation as a fraction in `[0, 1]`. */
  cpuLoad: number;
};

/** Everything Tier B needs to make a decision, supplied by the coordinator. */
export type AdjustmentEvaluationInput = {
  /** The budget currently being enforced. */
  current: ResourceBudget;
  /** Latest real-time resource sample. */
  sample: ResourceSample;
  /** Static machine profile (for fractions + the scale-up ceiling). */
  machine: MachineProfile;
  /** Unix-ms timestamps of recent automatic adjustments (for rate limiting). */
  recentAdjustmentsAt: readonly number[];
  /** Current wall-clock time (Unix ms); injected so the function stays pure. */
  now: number;
};

/**
 * The outcome of a Tier B evaluation. Either nothing changes (with a reason for
 * the log/UI) or a concrete adjustment is proposed. The `adjustment` is a full
 * {@link BudgetAdjustment} so the coordinator can hand it straight to
 * `appendBudgetAdjustment` (criterion 5.8).
 */
export type BudgetDecision =
  | { action: 'none'; reason: string }
  | { action: 'scale-down' | 'scale-up'; adjustment: BudgetAdjustment };

/**
 * Whether an adjustment must be suppressed because the rate limit was already
 * hit within the trailing window (criterion 5.7). Pure: `now` is supplied.
 */
export const isRateLimited = (recentAdjustmentsAt: readonly number[], now: number): boolean => {
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const countInWindow = recentAdjustmentsAt.filter((at) => at > windowStart).length;
  return countInWindow >= MAX_ADJUSTMENTS_PER_WINDOW;
};

/** Structural equality of two budgets (all kinds + both memory limits). */
const budgetsEqual = (a: ResourceBudget, b: ResourceBudget): boolean => {
  if (a.maxTotalMemoryMB !== b.maxTotalMemoryMB || a.reserveForUserMB !== b.reserveForUserMB) {
    return false;
  }
  return ALL_TASK_KINDS.every((kind) => a.maxConcurrent[kind] === b.maxConcurrent[kind]);
};

/** Produce a budget with every kind's concurrency stepped by `delta`, clamped to `[floor, ceiling]`. */
const stepConcurrency = (
  current: ResourceBudget,
  delta: number,
  floor: Record<TaskKind, number>,
  ceiling: Record<TaskKind, number>
): ResourceBudget => ({
  ...current,
  maxConcurrent: buildConcurrency((kind) => clamp(current.maxConcurrent[kind] + delta, floor[kind], ceiling[kind])),
});

/** Format a fraction in `[0, 1]` as a whole-number percentage for log reasons. */
const asPercent = (fraction: number): number => Math.round(fraction * 100);

/**
 * Tier B decision function (criteria 5.6, 5.7). Given the current budget, a live
 * pressure sample, and the recent-adjustment history, decide whether to scale
 * the budget down, up, or leave it unchanged.
 *
 * Decision rules:
 * - **Scale down** if free RAM is below {@link SCALE_DOWN_FREE_MEM_FRACTION}
 *   *or* CPU load is above {@link SCALE_DOWN_CPU_LOAD} (back off quickly).
 * - **Scale up** only if free RAM is above {@link SCALE_UP_FREE_MEM_FRACTION}
 *   *and* CPU load is below {@link SCALE_UP_CPU_LOAD} (ramp up cautiously).
 * - Otherwise the sample is inside the hysteresis dead-band → no change.
 *
 * Scale-down and scale-up thresholds never overlap, so the two conditions are
 * mutually exclusive. Any wanted change is suppressed when {@link isRateLimited}
 * is true, and is also suppressed when the budget is already pinned at the floor
 * (scale-down) or the performance ceiling (scale-up) — both cases signal that
 * Tier C deep analysis should take over.
 *
 * @returns A {@link BudgetDecision}; the function never mutates its inputs.
 */
export const evaluateAdjustment = (input: AdjustmentEvaluationInput): BudgetDecision => {
  const { current, sample, machine, recentAdjustmentsAt, now } = input;

  const freeFraction = machine.totalMemMB > 0 ? sample.freeMemMB / machine.totalMemMB : 0;
  const memoryPressure = freeFraction < SCALE_DOWN_FREE_MEM_FRACTION;
  const cpuPressure = sample.cpuLoad > SCALE_DOWN_CPU_LOAD;
  const memoryComfortable = freeFraction > SCALE_UP_FREE_MEM_FRACTION;
  const cpuComfortable = sample.cpuLoad < SCALE_UP_CPU_LOAD;

  const wantScaleDown = memoryPressure || cpuPressure;
  const wantScaleUp = memoryComfortable && cpuComfortable;

  if (!wantScaleDown && !wantScaleUp) {
    return {
      action: 'none',
      reason: `Within hysteresis dead-band (free RAM ${asPercent(freeFraction)}%, CPU load ${asPercent(sample.cpuLoad)}%); budget unchanged.`,
    };
  }

  if (isRateLimited(recentAdjustmentsAt, now)) {
    return {
      action: 'none',
      reason: `Adjustment suppressed: rate limit of ${MAX_ADJUSTMENTS_PER_WINDOW} per ${RATE_LIMIT_WINDOW_MS / 1000}s already reached.`,
    };
  }

  if (wantScaleDown) {
    const floor = buildConcurrency(() => ABSOLUTE_MIN_CONCURRENT);
    const to = stepConcurrency(current, -CONCURRENCY_STEP, floor, current.maxConcurrent);
    if (budgetsEqual(current, to)) {
      return {
        action: 'none',
        reason: `Per-kind concurrency already at the minimum (${ABSOLUTE_MIN_CONCURRENT}); Tier B cannot reduce further.`,
      };
    }
    const triggers: string[] = [];
    if (memoryPressure)
      triggers.push(
        `free RAM ${sample.freeMemMB}MB (${asPercent(freeFraction)}%) below ${asPercent(SCALE_DOWN_FREE_MEM_FRACTION)}% floor`
      );
    if (cpuPressure)
      triggers.push(`CPU load ${asPercent(sample.cpuLoad)}% above ${asPercent(SCALE_DOWN_CPU_LOAD)}% ceiling`);
    const reason = `Machine under pressure (${triggers.join('; ')}); reduced per-kind concurrency by ${CONCURRENCY_STEP}.`;
    return { action: 'scale-down', adjustment: { at: now, reason, from: current, to } };
  }

  const ceiling = presetBudget('performance', machine).maxConcurrent;
  const floor = current.maxConcurrent;
  const to = stepConcurrency(current, CONCURRENCY_STEP, floor, ceiling);
  if (budgetsEqual(current, to)) {
    return { action: 'none', reason: 'Per-kind concurrency already at the performance ceiling; no further increase.' };
  }
  const reason = `Resources comfortable (free RAM ${sample.freeMemMB}MB (${asPercent(freeFraction)}%) above ${asPercent(SCALE_UP_FREE_MEM_FRACTION)}%, CPU load ${asPercent(sample.cpuLoad)}% below ${asPercent(SCALE_UP_CPU_LOAD)}%); raised per-kind concurrency by ${CONCURRENCY_STEP}.`;
  return { action: 'scale-up', adjustment: { at: now, reason, from: current, to } };
};
