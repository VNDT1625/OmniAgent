/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure decision logic for silently recovering an aionrs conversation that was
 * interrupted *unintentionally* (network drop, provider/API-key error, backend
 * crash) before its turn finished.
 *
 * The renderer believes a turn is "running" while it sees stream activity. If
 * that activity stops without the turn completing normally, we cannot trust the
 * send/stop button state alone — the user might just be typing a new prompt. So
 * we determine liveness independently (was this a user stop? did the backend
 * report an error? is the backend still running?) and, when the stop was NOT
 * user-initiated, silently re-send a "continue" turn on the same conversation.
 *
 * This module is intentionally pure and deterministic (no timers, no I/O) so the
 * recovery policy can be unit-tested; the renderer hook drives it with real
 * clocks and the real stream / HTTP calls.
 */

/** How the current turn stopped, as observed from the stream / backend. */
export type TurnStopCause =
  | 'user-stop' // user clicked stop (or backend reported state==='stopped')
  | 'completed' // turn finished normally (finish + backend no longer running)
  | 'error' // backend emitted an error event for this turn
  | 'backend-dead' // liveness poll failed / backend no longer reachable
  | 'silent-stall'; // UI thinks running but no activity and backend not running

/**
 * Whether a given stop cause is an *unintentional* interruption that should be
 * silently resumed. A user stop or a normal completion must never be resumed.
 */
export const isRecoverableStopCause = (cause: TurnStopCause): boolean =>
  cause === 'error' || cause === 'backend-dead' || cause === 'silent-stall';

export type RecoveryConfig = {
  /**
   * While the UI believes a turn is running, no stream activity for this long
   * triggers a liveness check (poll the backend to confirm it really stopped).
   */
  stallTimeoutMs: number;
  /**
   * When the UI's running flag drops without a clean-completion signal, wait this
   * long for a late `turnCompleted` event before polling the backend to decide
   * whether the turn was interrupted. Keeps a normal finish from being treated
   * as an interruption.
   */
  verifyGraceMs: number;
  /**
   * Escalating back-off applied by the number of *consecutive* rejected resume
   * attempts. Each tuple is `[afterConsecutiveRejections, delayMs]`, evaluated
   * from the largest threshold down. Below the smallest threshold the delay is 0
   * (resume immediately).
   */
  escalation: ReadonlyArray<readonly [threshold: number, delayMs: number]>;
  /**
   * Hard cap on consecutive rejected resumes. Once reached, give up and surface
   * the interruption to the user instead of resuming again.
   */
  maxConsecutiveRejections: number;
};

/**
 * Defaults per product spec: detect a stall after ~45s of silence, resume
 * immediately for the first few failures, then escalate the wait as consecutive
 * rejections pile up, and give up after 20 in a row.
 *
 *  - < 5 consecutive rejections  -> resume immediately (0ms)
 *  - >= 5                        -> wait 15s
 *  - >= 10                       -> wait 30s
 *  - >= 15                       -> wait 60s
 *  - >= 20                       -> give up, report interruption
 */
export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  stallTimeoutMs: 45_000,
  verifyGraceMs: 4_000,
  escalation: [[0, 4_000]],
  maxConsecutiveRejections: 5,
};

/**
 * Compute the back-off delay (ms) to wait before the next resume, given how many
 * consecutive resume attempts have been rejected so far.
 */
export const getResumeDelayMs = (consecutiveRejections: number, config: RecoveryConfig): number => {
  for (const [threshold, delayMs] of config.escalation) {
    if (consecutiveRejections >= threshold) {
      return delayMs;
    }
  }
  return 0;
};

/** Whether the recovery loop has exhausted its retry budget and must give up. */
export const hasExhaustedRecovery = (consecutiveRejections: number, config: RecoveryConfig): boolean =>
  consecutiveRejections >= config.maxConsecutiveRejections;

export type RecoveryPhase =
  | 'idle' // not watching (no running turn, or recovery disabled)
  | 'watching' // a turn is running; watching for stall / interruption
  | 'verifying' // running dropped; waiting briefly to verify clean finish vs interruption
  | 'cooldown' // interruption detected; waiting out the back-off before resuming
  | 'exhausted'; // gave up after too many consecutive rejections

export type RecoveryState = {
  phase: RecoveryPhase;
  /** Timestamp of the last observed stream activity (used while watching). */
  lastActivityAt: number;
  /** Timestamp verification started (used while in verifying). */
  verifyingStartedAt: number;
  /** Timestamp the current cooldown started (used while in cooldown). */
  cooldownStartedAt: number;
  /** The back-off (ms) the current cooldown must wait out before resuming. */
  cooldownDelayMs: number;
  /** Consecutive rejected resume attempts (reset on a successful turn). */
  consecutiveRejections: number;
};

export const createInitialRecoveryState = (): RecoveryState => ({
  phase: 'idle',
  lastActivityAt: 0,
  verifyingStartedAt: 0,
  cooldownStartedAt: 0,
  cooldownDelayMs: 0,
  consecutiveRejections: 0,
});

export type RecoveryAction =
  | { type: 'none' }
  | { type: 'check-liveness' } // stalled/uncertain -> confirm backend really stopped
  | { type: 'resume' } // cooldown elapsed -> silently re-send the continue turn
  | { type: 'giveup' }; // budget exhausted -> report interruption to the user

/**
 * Decide what the recovery loop should do right now. Pure: does not mutate state.
 */
export const evaluateRecovery = (state: RecoveryState, now: number, config: RecoveryConfig): RecoveryAction => {
  if (state.phase === 'exhausted') {
    return { type: 'giveup' };
  }
  if (state.phase === 'watching') {
    if (now - state.lastActivityAt >= config.stallTimeoutMs) {
      return { type: 'check-liveness' };
    }
    return { type: 'none' };
  }
  if (state.phase === 'verifying') {
    if (now - state.verifyingStartedAt >= config.verifyGraceMs) {
      return { type: 'check-liveness' };
    }
    return { type: 'none' };
  }
  if (state.phase === 'cooldown') {
    if (hasExhaustedRecovery(state.consecutiveRejections, config)) {
      return { type: 'giveup' };
    }
    if (now - state.cooldownStartedAt >= state.cooldownDelayMs) {
      return { type: 'resume' };
    }
    return { type: 'none' };
  }
  return { type: 'none' };
};

// --- Deterministic state transitions (kept pure for testability) ---

/**
 * Begin watching a freshly started turn. Preserves the rejection counter so an
 * escalating back-off survives across consecutive interrupted turns.
 */
export const startWatching = (state: RecoveryState, now: number): RecoveryState => ({
  ...state,
  phase: 'watching',
  lastActivityAt: now,
  verifyingStartedAt: 0,
  cooldownStartedAt: 0,
  cooldownDelayMs: 0,
});

/**
 * The UI running flag dropped before we saw an authoritative clean-completion
 * signal. Wait briefly for a late `turnCompleted`; if none arrives, the ticker
 * will poll the backend and treat the stopped turn as interrupted.
 */
export const beginVerifying = (state: RecoveryState, now: number): RecoveryState => ({
  ...state,
  phase: 'verifying',
  verifyingStartedAt: now,
});

/** Record stream activity (heartbeat) while watching. */
export const recordActivity = (state: RecoveryState, now: number): RecoveryState =>
  state.phase === 'watching' ? { ...state, lastActivityAt: now } : state;

/**
 * An unintentional interruption was confirmed. Enter cooldown with the back-off
 * computed from the current consecutive-rejection count.
 */
export const enterCooldown = (state: RecoveryState, now: number, config: RecoveryConfig): RecoveryState => {
  if (hasExhaustedRecovery(state.consecutiveRejections, config)) {
    return { ...state, phase: 'exhausted' };
  }
  return {
    ...state,
    phase: 'cooldown',
    verifyingStartedAt: 0,
    cooldownStartedAt: now,
    cooldownDelayMs: getResumeDelayMs(state.consecutiveRejections, config),
  };
};

/**
 * A resume was just fired. Optimistically count it as a rejection and resume
 * watching; a later successful turn clears the counter via `markRecovered`.
 */
export const markResumeAttempt = (state: RecoveryState, now: number): RecoveryState => ({
  ...state,
  phase: 'watching',
  lastActivityAt: now,
  verifyingStartedAt: 0,
  cooldownStartedAt: 0,
  cooldownDelayMs: 0,
  consecutiveRejections: state.consecutiveRejections + 1,
});

/** A turn completed successfully — clear the rejection counter and stop watching. */
export const markRecovered = (): RecoveryState => createInitialRecoveryState();

/** Stop watching entirely (e.g. user stop, conversation switch, recovery off). */
export const stopWatching = (): RecoveryState => createInitialRecoveryState();
