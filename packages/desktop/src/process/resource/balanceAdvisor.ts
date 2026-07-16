/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tier C of the ResourceCoordinator's balancing strategy (Requirement 5 —
 * anti-lag resource management, "bậc c — AI phân tích sâu"; criteria 5.6 / 5.8).
 *
 * Tier A (`balancePolicy.suggestPreset` / `presetBudget`) picks a starting
 * budget from the static machine profile, and Tier B
 * (`balancePolicy.evaluateAdjustment`) nudges that budget up and down with
 * rule-based hysteresis while the machine runs. When the machine **still** lags
 * after several Tier B cycles — i.e. the rule engine could not relieve the
 * pressure (it is pinned at the concurrency floor, or its small steps are not
 * enough) — this module escalates to an AI agent for a deeper, holistic look.
 *
 * The flow this module implements:
 *
 * 1. {@link shouldEscalate} — a **pure** predicate the coordinator calls to
 *    decide whether Tier C should trigger at all (persistent lag across
 *    {@link DEFAULT_ESCALATION_CYCLES} sampling cycles).
 * 2. {@link buildAnalysisPrompt} — a **pure** builder that packages the current
 *    {@link ResourceState} (machine profile, budget, recent pressure samples,
 *    and the `lastAdjustments` history with their reasons) into a prompt asking
 *    the agent for a new budget.
 * 3. {@link createBalanceAdvisor} — the advisor itself. It calls the injected
 *    {@link AskAgent}, robustly parses the proposed budget out of the (possibly
 *    messy) agent response, validates and clamps it to sane bounds, and returns
 *    a ready-to-apply {@link BudgetAdjustment} (or `null` when nothing should
 *    change or the response could not be parsed).
 *
 * ## Design decisions
 *
 * - **The advisor never persists and never applies.** It returns a
 *   {@link BudgetAdjustment}; the *coordinator* applies it through its existing
 *   path (`appendBudgetAdjustment`, criterion 5.8), so the `reason` is recorded
 *   exactly like a Tier B adjustment. This keeps the advisor free of file-system
 *   side effects and avoids an import cycle with `resourceCoordinator.ts` — this
 *   module depends only on the shared types and the policy constants.
 * - **The agent call is injected** (`askAgent`) rather than hard-wiring a
 *   specific aioncore conversation. That keeps the module trivially mockable and
 *   lets the real wiring (a temporary aioncore conversation, a cheap model, …)
 *   be plugged in later by the integration task without touching this file.
 * - **The model call is heavy and must itself be lease-gated.** Because the
 *   advisor deliberately does not import the coordinator, **the caller
 *   (coordinator) is responsible for `requestLease` / `releaseLease`** around
 *   the `askAgent` invocation. This module assumes the lease has already been
 *   granted by the time {@link BalanceAdvisor.analyze} is called.
 * - **Never throws on a bad response.** A failed agent call, an empty reply, or
 *   unparseable text all resolve to `null` (with a warning logged) so a flaky
 *   model can never crash the balancing loop.
 *
 * ## Purity
 *
 * {@link shouldEscalate} and {@link buildAnalysisPrompt} are pure (no clock, no
 * IO). The advisor's only impurity is the injected `askAgent` and an injectable
 * `now` clock, mirroring the rest of the resource module's testability strategy.
 */

import {
  ABSOLUTE_MIN_CONCURRENT,
  MIN_HEAVY_MEMORY_MB,
  MIN_RESERVE_FOR_USER_MB,
  presetBudget,
  SCALE_DOWN_CPU_LOAD,
  SCALE_DOWN_FREE_MEM_FRACTION,
  type ResourceSample,
} from './balancePolicy';
import type { BudgetAdjustment, MachineProfile, ResourceBudget, ResourceState, TaskKind } from './leaseTypes';

/**
 * Number of consecutive lagging sampling cycles required before Tier C is
 * allowed to escalate (the "M chu kỳ" of design.md). With Tier B sampling every
 * `BALANCE_INTERVAL_MS` (5s by default), the default of six cycles means the
 * machine must have been under sustained pressure for roughly 30 seconds — long
 * enough that the cheap rule-based tier has demonstrably failed — before paying
 * for the expensive AI analysis.
 */
export const DEFAULT_ESCALATION_CYCLES = 6;

/** Cap on how many recent samples / adjustments are embedded in the prompt. */
const PROMPT_HISTORY_LIMIT = 10;

/** Every {@link TaskKind} present in a budget, derived from the budget itself. */
const taskKindsOf = (budget: ResourceBudget): TaskKind[] => Object.keys(budget.maxConcurrent) as TaskKind[];

/** Type guard for a usable finite number (rejects `NaN`, `Infinity`, non-numbers). */
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Round to the nearest integer and clamp into `[min, max]` (order-tolerant). */
const clampInt = (value: number, min: number, max: number): number => {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.min(Math.max(Math.round(value), lo), hi);
};

/**
 * Whether a single pressure sample counts as "lagging", using the very same
 * thresholds Tier B uses to decide it should scale **down**: free RAM below
 * {@link SCALE_DOWN_FREE_MEM_FRACTION} of total, or CPU load above
 * {@link SCALE_DOWN_CPU_LOAD}. Reusing the Tier B thresholds keeps the two tiers
 * consistent about what "under pressure" means.
 */
const isSampleUnderPressure = (sample: ResourceSample, machine: MachineProfile): boolean => {
  const freeFraction = machine.totalMemMB > 0 ? sample.freeMemMB / machine.totalMemMB : 0;
  return freeFraction < SCALE_DOWN_FREE_MEM_FRACTION || sample.cpuLoad > SCALE_DOWN_CPU_LOAD;
};

/**
 * Decide whether Tier C (AI deep analysis) should trigger (pure predicate).
 *
 * Escalation is warranted only when **all** of the most recent `cycles` samples
 * are under pressure — i.e. the machine has lagged continuously while Tier B was
 * running, which means the rule-based tier could not relieve it. The check is
 * scoped to `suggest` mode: in `detailed` mode the user owns the budget and the
 * coordinator must not auto-rebalance.
 *
 * @param state         The current coordinator state (for `mode` + `machine`).
 * @param recentSamples Trailing window of live pressure samples, oldest first.
 * @param cycles        Consecutive-lag threshold; defaults to
 *                      {@link DEFAULT_ESCALATION_CYCLES}.
 * @returns `true` when the latest `cycles` samples are all lagging.
 */
export const shouldEscalate = (
  state: ResourceState,
  recentSamples: readonly ResourceSample[],
  cycles: number = DEFAULT_ESCALATION_CYCLES
): boolean => {
  if (state.mode !== 'suggest') return false;
  if (!Number.isFinite(cycles) || cycles <= 0) return false;
  if (recentSamples.length < cycles) return false;
  const window = recentSamples.slice(-cycles);
  return window.every((sample) => isSampleUnderPressure(sample, state.machine));
};

/**
 * Build the deep-analysis prompt sent to the agent (pure string builder).
 *
 * The prompt packages everything the agent needs to reason about the lag: the
 * static machine profile, the budget currently in force, a compact view of the
 * most recent pressure samples, and the history of past automatic adjustments
 * (with the `reason` recorded for each). It closes with a strict instruction to
 * reply with a single JSON object describing the proposed budget, so the
 * response is easy to parse. Out-of-range numbers are tolerated because
 * {@link createBalanceAdvisor} clamps them to safe bounds.
 *
 * @param state         The current coordinator state.
 * @param recentSamples Trailing window of live pressure samples, oldest first.
 * @returns A self-contained prompt string.
 */
export const buildAnalysisPrompt = (state: ResourceState, recentSamples: readonly ResourceSample[] = []): string => {
  const { machine, budget, mode, preset } = state;
  const kinds = taskKindsOf(budget);

  const machineSection = [
    'MACHINE PROFILE:',
    `- Total RAM: ${machine.totalMemMB} MB`,
    `- CPU cores: ${machine.cpuCores}`,
    `- Discrete GPU: ${machine.hasDiscreteGPU ? 'present' : 'absent'}`,
    `- Free disk: ${machine.freeDiskMB} MB`,
  ].join('\n');

  const budgetSection = [
    'CURRENT BUDGET:',
    `- mode: ${mode}`,
    `- preset: ${preset}`,
    `- maxTotalMemoryMB: ${budget.maxTotalMemoryMB}`,
    `- reserveForUserMB: ${budget.reserveForUserMB}`,
    `- maxConcurrent: ${kinds.map((kind) => `${kind}=${budget.maxConcurrent[kind]}`).join(', ')}`,
  ].join('\n');

  const samplesSection =
    recentSamples.length > 0
      ? [
          'RECENT PRESSURE SAMPLES (oldest first):',
          ...recentSamples
            .slice(-PROMPT_HISTORY_LIMIT)
            .map(
              (sample, index) =>
                `- #${index + 1}: freeMem=${sample.freeMemMB} MB, cpuLoad=${Math.round(sample.cpuLoad * 100)}%`
            ),
        ].join('\n')
      : 'RECENT PRESSURE SAMPLES: (none provided)';

  const historySection =
    state.lastAdjustments.length > 0
      ? [
          'ADJUSTMENT HISTORY (most recent last):',
          ...state.lastAdjustments
            .slice(-PROMPT_HISTORY_LIMIT)
            .map((adjustment) => `- ${new Date(adjustment.at).toISOString()}: ${adjustment.reason}`),
        ].join('\n')
      : 'ADJUSTMENT HISTORY: (none yet)';

  const responseSection = [
    'TASK:',
    'The machine is still lagging after several automatic (rule-based) balancing',
    'cycles failed to relieve the pressure. Analyse the data above and propose a',
    'NEW resource budget that should reduce the lag while keeping the machine usable.',
    '',
    'Respond with ONLY a single JSON object (no prose, no code fences) shaped like:',
    '{',
    `  "maxConcurrent": { ${kinds.map((kind) => `"${kind}": <integer>`).join(', ')} },`,
    '  "maxTotalMemoryMB": <integer MB>,',
    '  "reserveForUserMB": <integer MB>,',
    '  "reason": "<short human-readable explanation of the change>"',
    '}',
    '',
    `Guidance: per-kind concurrency must be at least ${ABSOLUTE_MIN_CONCURRENT}; maxTotalMemoryMB at least ${MIN_HEAVY_MEMORY_MB}; reserveForUserMB at least ${MIN_RESERVE_FOR_USER_MB}.`,
    'Lower concurrency and a higher user reserve reduce lag; raise them only if the machine looks comfortable.',
    'Out-of-range values will be clamped to safe bounds, so prefer realistic numbers.',
  ].join('\n');

  return [machineSection, budgetSection, samplesSection, historySection, responseSection].join('\n\n');
};

/** Strip a single ```/```json fenced block, returning its contents if present. */
const stripCodeFences = (text: string): string => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1] : text;
};

/**
 * Best-effort extraction of a JSON object from a free-form agent reply.
 *
 * Tries, in order: the whole (de-fenced) string, then the substring spanning the
 * first `{` to the last `}`. Returns `undefined` if nothing parses — callers
 * treat that as "no proposal".
 */
const extractJsonObject = (text: string): unknown => {
  const stripped = stripCodeFences(text).trim();
  const candidates = [stripped];
  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(stripped.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next, more aggressive candidate.
    }
  }
  return undefined;
};

/**
 * Coerce a raw parsed object into a well-formed, safely-bounded
 * {@link ResourceBudget}.
 *
 * Every field is optional in the agent's reply: missing or invalid fields fall
 * back to the current budget's value. Each value is then clamped:
 * - per-kind concurrency → `[ABSOLUTE_MIN_CONCURRENT, max(performance ceiling, current)]`
 * - `maxTotalMemoryMB`   → `[MIN_HEAVY_MEMORY_MB, max(performance ceiling, current)]`
 * - `reserveForUserMB`   → `[MIN_RESERVE_FOR_USER_MB, max(total RAM, current)]`
 *
 * The performance preset is used as the upper bound so the AI can never grant
 * more than the most aggressive built-in level would on this machine, while the
 * `max(..., current)` keeps an already-custom higher value from being forced
 * down by the clamp alone.
 */
const clampToBudget = (
  raw: Record<string, unknown>,
  current: ResourceBudget,
  machine: MachineProfile
): ResourceBudget => {
  const ceiling = presetBudget('performance', machine);
  const proposedConcurrent =
    typeof raw.maxConcurrent === 'object' && raw.maxConcurrent !== null
      ? (raw.maxConcurrent as Record<string, unknown>)
      : {};

  const maxConcurrent = {} as Record<TaskKind, number>;
  for (const kind of taskKindsOf(current)) {
    const proposed = proposedConcurrent[kind];
    const base = isFiniteNumber(proposed) ? proposed : current.maxConcurrent[kind];
    const upper = Math.max(ceiling.maxConcurrent[kind], current.maxConcurrent[kind]);
    maxConcurrent[kind] = clampInt(base, ABSOLUTE_MIN_CONCURRENT, upper);
  }

  const memoryUpper = Math.max(ceiling.maxTotalMemoryMB, current.maxTotalMemoryMB);
  const maxTotalMemoryMB = clampInt(
    isFiniteNumber(raw.maxTotalMemoryMB) ? raw.maxTotalMemoryMB : current.maxTotalMemoryMB,
    MIN_HEAVY_MEMORY_MB,
    memoryUpper
  );

  const reserveUpper = Math.max(MIN_RESERVE_FOR_USER_MB, machine.totalMemMB, current.reserveForUserMB);
  const reserveForUserMB = clampInt(
    isFiniteNumber(raw.reserveForUserMB) ? raw.reserveForUserMB : current.reserveForUserMB,
    MIN_RESERVE_FOR_USER_MB,
    reserveUpper
  );

  return { maxConcurrent, maxTotalMemoryMB, reserveForUserMB };
};

/** Structural equality of two budgets (every kind + both memory limits). */
const budgetsEqual = (a: ResourceBudget, b: ResourceBudget): boolean => {
  if (a.maxTotalMemoryMB !== b.maxTotalMemoryMB || a.reserveForUserMB !== b.reserveForUserMB) return false;
  return taskKindsOf(a).every((kind) => a.maxConcurrent[kind] === b.maxConcurrent[kind]);
};

/**
 * The single heavy dependency of the advisor: a function that sends the prompt
 * to an agent / model and resolves its raw text reply. Injected so the real
 * wiring (an aioncore conversation, a cheap model, …) can be supplied later and
 * so tests can mock it. The caller is responsible for lease-gating this call.
 */
export type AskAgent = (prompt: string) => Promise<string>;

/** Injectable dependencies for {@link createBalanceAdvisor}. */
export type BalanceAdvisorDeps = {
  /** Sends the analysis prompt to an agent and resolves its raw reply. */
  askAgent: AskAgent;
  /** Wall-clock source (Unix ms) for the adjustment timestamp. Defaults to `Date.now`. */
  now?: () => number;
};

/** Input for a single Tier C analysis pass. */
export type BalanceAnalysisInput = {
  /** The current coordinator state to analyse. */
  state: ResourceState;
  /** Optional trailing window of pressure samples to include in the prompt. */
  recentSamples?: readonly ResourceSample[];
};

/** Public surface of the Tier C advisor. */
export type BalanceAdvisor = {
  /**
   * Run one deep-analysis pass. Resolves a {@link BudgetAdjustment} ready for the
   * coordinator to apply + persist, or `null` when the agent failed, replied
   * unparseably, or proposed no effective change. Never rejects.
   */
  analyze: (input: BalanceAnalysisInput) => Promise<BudgetAdjustment | null>;
};

/**
 * Create a Tier C balance advisor (Requirement 5, criteria 5.6 / 5.8).
 *
 * The returned advisor builds the analysis prompt, calls the injected
 * {@link AskAgent}, parses + clamps the proposed budget, and returns a
 * {@link BudgetAdjustment} (with the agent's explanation as its `reason`) for the
 * coordinator to apply through `appendBudgetAdjustment`. It performs no
 * persistence itself and never throws on a bad agent response.
 *
 * @param deps Injectable dependencies (`askAgent`, optional `now`).
 * @returns A {@link BalanceAdvisor}.
 */
export const createBalanceAdvisor = (deps: BalanceAdvisorDeps): BalanceAdvisor => {
  const now = deps.now ?? (() => Date.now());

  const analyze = async ({ state, recentSamples = [] }: BalanceAnalysisInput): Promise<BudgetAdjustment | null> => {
    const prompt = buildAnalysisPrompt(state, recentSamples);

    let response: string;
    try {
      response = await deps.askAgent(prompt);
    } catch (error) {
      console.warn('[Resource] Tier C advisor: askAgent call failed; keeping current budget:', error);
      return null;
    }

    if (typeof response !== 'string' || response.trim().length === 0) {
      console.warn('[Resource] Tier C advisor: empty agent response; keeping current budget.');
      return null;
    }

    const parsed = extractJsonObject(response);
    if (parsed === null || typeof parsed !== 'object') {
      console.warn(
        '[Resource] Tier C advisor: could not parse a budget object from the agent response; keeping current budget.'
      );
      return null;
    }

    const raw = parsed as Record<string, unknown>;
    const proposed = clampToBudget(raw, state.budget, state.machine);
    if (budgetsEqual(proposed, state.budget)) {
      return null;
    }

    const explanation =
      typeof raw.reason === 'string' && raw.reason.trim().length > 0
        ? raw.reason.trim()
        : 'AI deep analysis proposed a new resource budget after persistent lag.';

    return {
      at: now(),
      reason: `Tier C deep analysis: ${explanation}`,
      from: state.budget,
      to: proposed,
    };
  };

  return { analyze };
};
