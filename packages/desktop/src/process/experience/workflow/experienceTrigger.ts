/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conditional retrieval trigger (Phase 2).
 *
 * ExpBase must be proactive but economical: it should NOT run a lookup on every
 * turn, only when the agent is actually stuck on a hard bug. This in-memory
 * tracker mirrors the project's `autonomous-run` rule ("fix 2 lần không xong"):
 *
 * - A failing verify/test/typecheck increments a per-signature failure counter.
 * - Retrieval fires when the counter reaches `threshold` (default 2).
 * - A `hard` signal (crash, panic, segfault, OOM) fires immediately.
 * - A passing signal resets the counter for that signature.
 *
 * Pure and deterministic — no I/O, no model calls.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

/** Severity of a failure signal; `hard` fires retrieval on the first occurrence. */
export type TriggerSeverity = 'normal' | 'hard';

/** A verify/test outcome observed by the trigger. */
export type TriggerSignal = {
  projectId: string;
  /** Stable key for the failing situation, e.g. `${command}|${errorCategory}`. */
  signature: string;
  outcome: 'failed' | 'passed';
  severity?: TriggerSeverity;
};

/** The trigger's decision for an observed signal. */
export type TriggerDecision = {
  shouldRetrieve: boolean;
  failureCount: number;
  reason: string;
};

/** Options for {@link createExperienceTrigger}. */
export type ExperienceTriggerOptions = {
  /** Consecutive failures before retrieval fires. Defaults to 2. */
  threshold?: number;
  /** Patterns marking a failure as `hard` (immediate trigger) by error text. */
  hardPatterns?: RegExp[];
};

/** Default markers of a severe failure that warrants an immediate lookup. */
export const DEFAULT_HARD_PATTERNS: RegExp[] = [
  /\bsegfault\b/i,
  /\bpanic(ked)?\b/i,
  /\bcore dumped\b/i,
  /\bout of memory\b|\boom\b|\bheap out of memory\b/i,
  /\bstack overflow\b/i,
  /\bfatal\b/i,
  /\bunhandled (exception|rejection)\b/i,
];

/** Classify free error text as `hard` or `normal`. */
export const classifySeverity = (errorText: string, hardPatterns: RegExp[] = DEFAULT_HARD_PATTERNS): TriggerSeverity =>
  hardPatterns.some((pattern) => pattern.test(errorText)) ? 'hard' : 'normal';

/** A trigger instance tracking consecutive failures per signature. */
export type ExperienceTrigger = {
  observe(signal: TriggerSignal): TriggerDecision;
  /** Current failure count for a signature (0 if unknown). */
  peek(projectId: string, signature: string): number;
  reset(projectId: string, signature: string): void;
  resetAll(): void;
};

/** Create a conditional retrieval trigger. */
export const createExperienceTrigger = (options: ExperienceTriggerOptions = {}): ExperienceTrigger => {
  const threshold = Math.max(1, options.threshold ?? 2);
  const counts = new Map<string, number>();
  const key = (projectId: string, signature: string): string => `${projectId}\u0000${signature}`;

  const observe = (signal: TriggerSignal): TriggerDecision => {
    const mapKey = key(signal.projectId, signal.signature);
    if (signal.outcome === 'passed') {
      counts.delete(mapKey);
      return { shouldRetrieve: false, failureCount: 0, reason: 'passed' };
    }
    const failureCount = (counts.get(mapKey) ?? 0) + 1;
    counts.set(mapKey, failureCount);

    if (signal.severity === 'hard') {
      return { shouldRetrieve: true, failureCount, reason: 'hard-failure' };
    }
    if (failureCount >= threshold) {
      return { shouldRetrieve: true, failureCount, reason: `reached-threshold-${threshold}` };
    }
    return { shouldRetrieve: false, failureCount, reason: `below-threshold-${threshold}` };
  };

  return {
    observe,
    peek: (projectId, signature) => counts.get(key(projectId, signature)) ?? 0,
    reset: (projectId, signature) => {
      counts.delete(key(projectId, signature));
    },
    resetAll: () => counts.clear(),
  };
};

/** Build a stable signature for a failing situation from its salient fields. */
export const buildSignature = (parts: { command?: string; errorCategory?: string; file?: string }): string =>
  [parts.command, parts.errorCategory, parts.file]
    .map((part) => (part ?? '').trim().toLowerCase())
    .filter((part) => part.length > 0)
    .join('|') || 'unknown';
