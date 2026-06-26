/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure decision logic for the goal auto-resume watchdog.
 *
 * The goal pipeline (see `goalCommand.ts` / `.claude/commands/goal.md`) requires
 * the agent to keep running until the goal is met. If the agent's turn stalls
 * (e.g. a hung terminal or a stuck server keeps the turn "running" with no stream
 * activity), the watchdog cancels the turn, waits a cooldown, then re-sends the
 * original goal so the agent resumes — capped to avoid runaway cost.
 *
 * This module is intentionally pure and deterministic (no timers, no I/O) so the
 * timing logic can be unit-tested; the renderer hook drives it with real clocks.
 */

export type GoalWatchdogConfig = {
  /** While running, no stream activity for this long ⇒ treat the turn as stalled. */
  stallTimeoutMs: number;
  /** After cancelling a stalled turn, wait this long before re-sending the goal. */
  resumeDelayMs: number;
  /** Hard cap on automatic resumes per goal run (prevents runaway loops/cost). */
  maxResumes: number;
};

// Conservative defaults matching the user's spec: detect a hang after ~5 min of
// silence, wait ~5 min, resume, at most 3 times.
export const DEFAULT_GOAL_WATCHDOG_CONFIG: GoalWatchdogConfig = {
  stallTimeoutMs: 5 * 60_000,
  resumeDelayMs: 5 * 60_000,
  maxResumes: 3,
};

export type GoalWatchdogPhase =
  | 'idle' // not watching
  | 'running' // a goal turn is running; watching for stall
  | 'cooldown'; // stalled turn cancelled; waiting before resume

export type GoalWatchdogState = {
  phase: GoalWatchdogPhase;
  /** Timestamp of the last observed stream activity (used in 'running'). */
  lastActivityAt: number;
  /** Timestamp the cooldown started (used in 'cooldown'). */
  cooldownStartedAt: number;
  /** How many automatic resumes have happened in this goal run. */
  resumeCount: number;
};

export const createInitialWatchdogState = (): GoalWatchdogState => ({
  phase: 'idle',
  lastActivityAt: 0,
  cooldownStartedAt: 0,
  resumeCount: 0,
});

export type GoalWatchdogAction =
  | { type: 'none' }
  | { type: 'stop' } // cancel the stalled turn, then enter cooldown
  | { type: 'resume' } // cooldown elapsed, re-send the goal
  | { type: 'giveup' }; // exceeded maxResumes, stop watching

/**
 * Decide what the watchdog should do right now. Does not mutate state.
 */
export const evaluateWatchdog = (
  state: GoalWatchdogState,
  now: number,
  config: GoalWatchdogConfig
): GoalWatchdogAction => {
  if (state.phase === 'running') {
    if (now - state.lastActivityAt >= config.stallTimeoutMs) {
      return state.resumeCount >= config.maxResumes ? { type: 'giveup' } : { type: 'stop' };
    }
    return { type: 'none' };
  }
  if (state.phase === 'cooldown') {
    if (now - state.cooldownStartedAt >= config.resumeDelayMs) {
      return state.resumeCount >= config.maxResumes ? { type: 'giveup' } : { type: 'resume' };
    }
    return { type: 'none' };
  }
  return { type: 'none' };
};

// --- Deterministic state transitions (kept pure for testability) ---

/** Arm the watchdog for a freshly user-initiated goal run. Resets the resume counter. */
export const armWatchdog = (now: number): GoalWatchdogState => ({
  phase: 'running',
  lastActivityAt: now,
  cooldownStartedAt: 0,
  resumeCount: 0,
});

/** Record stream activity (heartbeat) while running. */
export const recordActivity = (state: GoalWatchdogState, now: number): GoalWatchdogState =>
  state.phase === 'running' ? { ...state, lastActivityAt: now } : state;

/** Transition into cooldown after cancelling a stalled turn. */
export const enterCooldown = (state: GoalWatchdogState, now: number): GoalWatchdogState => ({
  ...state,
  phase: 'cooldown',
  cooldownStartedAt: now,
});

/** Transition back to running after a resume, incrementing the resume counter. */
export const markResumed = (state: GoalWatchdogState, now: number): GoalWatchdogState => ({
  phase: 'running',
  lastActivityAt: now,
  cooldownStartedAt: 0,
  resumeCount: state.resumeCount + 1,
});

/** Stop watching entirely. */
export const disarmWatchdog = (): GoalWatchdogState => createInitialWatchdogState();
