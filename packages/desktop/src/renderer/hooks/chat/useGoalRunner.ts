/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import {
  advanceComplianceState,
  createInitialComplianceState,
  decideCompliance,
  DEFAULT_GOAL_COMPLIANCE_CONFIG,
  hasVerificationEvidence,
  parseGoalStatus,
  type GoalComplianceConfig,
  type GoalComplianceState,
} from '@/common/chat/slash/goalCompliance';
import {
  armWatchdog,
  createInitialWatchdogState,
  disarmWatchdog,
  enterCooldown,
  evaluateWatchdog,
  markResumed,
  recordActivity,
  DEFAULT_GOAL_WATCHDOG_CONFIG,
  type GoalWatchdogConfig,
  type GoalWatchdogState,
} from '@/common/chat/slash/goalWatchdog';
import { useCallback, useEffect, useRef } from 'react';

export type GoalRunnerPayload = { input: string; files: string[] };

export type GoalHaltReason = 'blocked' | 'max-turns' | 'max-corrections';

type UseGoalRunnerOptions = {
  conversation_id: string;
  /** Whether a turn is currently running (isBusy). */
  running: boolean;
  /** Whether Goal Mode is active for this conversation. */
  goalModeActive: boolean;
  /** The original goal to re-send when a turn stalls (hang recovery). */
  getResumePayload: () => GoalRunnerPayload | null;
  /** Cancel the current (stalled) turn. */
  onStall: () => Promise<void> | void;
  /** Send an auto-driven turn (resume / continue / correct / reject). */
  send: (payload: GoalRunnerPayload) => Promise<void> | void;
  /**
   * Independent verification of a `done` claim. Returns the outcome, or null when
   * no verification is configured (then `done` is accepted on the marker alone).
   * When it returns `{ passed: false }`, the run is NOT accepted — the agent is
   * driven to fix and try again.
   */
  verify?: () => Promise<{ passed: boolean; output: string } | null>;
  /** Goal reported done with tests passing — stop the run. */
  onAccept: () => void;
  /** Run halted (blocked, or a cap was hit). */
  onHalt: (reason: GoalHaltReason) => void;
  /** Optional notice for auto-driven actions. */
  onNotice?: (
    kind: 'resume' | 'continue' | 'correct' | 'reject' | 'verify-fail',
    detail: { resumeCount: number }
  ) => void;
  watchdogConfig?: GoalWatchdogConfig;
  complianceConfig?: GoalComplianceConfig;
};

const TICK_INTERVAL_MS = 15_000;

const extractChunk = (data: unknown): string => {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object' && 'content' in data) {
    const content = (data as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return '';
};

/** Agent-facing message when independent verification of a done claim fails. */
const buildVerifyFailPrompt = (output: string): string =>
  [
    'KIỂM CHỨNG ĐỘC LẬP THẤT BẠI: lệnh verify trong workspace trả exit code ≠ 0.',
    'KHÔNG được coi là HOÀN THÀNH. Output (đuôi):',
    '```',
    output || '(no output)',
    '```',
    'Sửa lỗi (root-cause) rồi tiếp tục. Chỉ next=done khi lệnh verify thực sự pass. Kết thúc lượt bằng [[GOAL ...]].',
  ].join('\n');

/**
 * Renderer-driven Goal run orchestrator: combines hang recovery (stall watchdog)
 * and hard compliance enforcement (status-marker gating) into a single control
 * loop with one stream subscription.
 *
 * While Goal Mode is active the agent MUST end each turn with a `[[GOAL ...]]`
 * marker. On each finished turn the renderer parses it and, by code:
 *  - accepts only when next=done & tests=pass,
 *  - otherwise drives the next turn (continue / correct / reject) until done,
 *  - halts on blocked or when a hard cap is reached.
 * If a turn never finishes (hang), the stall path cancels and re-sends the goal.
 * All auto-driving is capped so cost stays finite.
 */
export const useGoalRunner = (options: UseGoalRunnerOptions) => {
  const {
    conversation_id,
    running,
    goalModeActive,
    getResumePayload,
    onStall,
    send,
    verify,
    onAccept,
    onHalt,
    onNotice,
    watchdogConfig = DEFAULT_GOAL_WATCHDOG_CONFIG,
    complianceConfig = DEFAULT_GOAL_COMPLIANCE_CONFIG,
  } = options;

  const watchdogRef = useRef<GoalWatchdogState>(createInitialWatchdogState());
  const complianceRef = useRef<GoalComplianceState>(createInitialComplianceState());
  const bufferRef = useRef('');
  // Whether verification activity (tests/typecheck/lint/...) was observed during
  // the current run — accumulated across turns, reset when the run ends.
  const evidenceRef = useRef(false);
  const busyRef = useRef(false);
  const runningRef = useRef(running);
  const goalActiveRef = useRef(goalModeActive);

  const latest = useRef({
    getResumePayload,
    onStall,
    send,
    verify,
    onAccept,
    onHalt,
    onNotice,
    watchdogConfig,
    complianceConfig,
  });
  useEffect(() => {
    latest.current = {
      getResumePayload,
      onStall,
      send,
      verify,
      onAccept,
      onHalt,
      onNotice,
      watchdogConfig,
      complianceConfig,
    };
  }, [getResumePayload, onStall, send, verify, onAccept, onHalt, onNotice, watchdogConfig, complianceConfig]);

  useEffect(() => {
    goalActiveRef.current = goalModeActive;
    if (!goalModeActive) {
      watchdogRef.current = disarmWatchdog();
      complianceRef.current = createInitialComplianceState();
      bufferRef.current = '';
      evidenceRef.current = false;
    }
  }, [goalModeActive]);

  const driveSend = useCallback((payload: GoalRunnerPayload) => {
    busyRef.current = true;
    // The auto-driven turn starts a new turn; (re)arm the stall watchdog for it.
    watchdogRef.current = armWatchdog(Date.now());
    bufferRef.current = '';
    void (async () => {
      try {
        await latest.current.send(payload);
      } catch {
        // Best-effort; a failed auto-drive should not crash the runner.
      } finally {
        busyRef.current = false;
      }
    })();
  }, []);

  const handleFinish = useCallback(() => {
    if (!goalActiveRef.current || busyRef.current) {
      bufferRef.current = '';
      return;
    }
    const status = parseGoalStatus(bufferRef.current);
    bufferRef.current = '';
    const decision = decideCompliance(status, complianceRef.current, latest.current.complianceConfig);

    // The agent claims done — gate it on independent verification (if configured)
    // instead of trusting the self-reported status.
    if (decision.type === 'accept') {
      busyRef.current = true;
      void (async () => {
        try {
          const result = latest.current.verify ? await latest.current.verify() : null;
          if (!result || result.passed) {
            watchdogRef.current = disarmWatchdog();
            complianceRef.current = createInitialComplianceState();
            latest.current.onAccept();
            return;
          }
          // Verification failed → do NOT accept; drive a fix turn (respect the cap).
          if (complianceRef.current.autoTurns >= latest.current.complianceConfig.maxAutoTurns) {
            watchdogRef.current = disarmWatchdog();
            complianceRef.current = createInitialComplianceState();
            latest.current.onHalt('max-turns');
            return;
          }
          complianceRef.current = { autoTurns: complianceRef.current.autoTurns + 1, corrections: 0 };
          latest.current.onNotice?.('verify-fail', { resumeCount: 0 });
          watchdogRef.current = armWatchdog(Date.now());
          await latest.current.send({ input: buildVerifyFailPrompt(result.output), files: [] });
        } catch {
          // best-effort
        } finally {
          busyRef.current = false;
        }
      })();
      return;
    }

    complianceRef.current = advanceComplianceState(complianceRef.current, decision);
    switch (decision.type) {
      case 'halt':
        watchdogRef.current = disarmWatchdog();
        complianceRef.current = createInitialComplianceState();
        latest.current.onHalt(decision.reason);
        return;
      case 'continue':
        latest.current.onNotice?.('continue', { resumeCount: 0 });
        driveSend({ input: decision.prompt, files: [] });
        return;
      case 'correct':
        latest.current.onNotice?.('correct', { resumeCount: 0 });
        driveSend({ input: decision.prompt, files: [] });
        return;
      case 'reject':
        latest.current.onNotice?.('reject', { resumeCount: 0 });
        driveSend({ input: decision.prompt, files: [] });
        return;
    }
  }, [driveSend]);

  // Single stream subscription: heartbeat + assistant-text accumulation + finish.
  useEffect(() => {
    const unsubscribe = ipcBridge.conversation.responseStream.on((message) => {
      if (message.conversation_id !== conversation_id) return;
      watchdogRef.current = recordActivity(watchdogRef.current, Date.now());
      if (message.type === 'content' || message.type === 'text') {
        bufferRef.current += extractChunk(message.data);
      } else if (message.type === 'finish') {
        handleFinish();
      }
    });
    return unsubscribe;
  }, [conversation_id, handleFinish]);

  // Arm the stall watchdog when a goal turn starts running.
  useEffect(() => {
    const wasRunning = runningRef.current;
    runningRef.current = running;
    if (goalModeActive && running && !wasRunning && watchdogRef.current.phase === 'idle') {
      watchdogRef.current = armWatchdog(Date.now());
    }
  }, [running, goalModeActive]);

  // Stall ticker: cancel a hung turn, cooldown, then re-send the goal.
  useEffect(() => {
    const timer = setInterval(() => {
      if (busyRef.current || !goalActiveRef.current) return;
      const action = evaluateWatchdog(watchdogRef.current, Date.now(), latest.current.watchdogConfig);
      if (action.type === 'none') return;

      if (action.type === 'stop') {
        busyRef.current = true;
        watchdogRef.current = enterCooldown(watchdogRef.current, Date.now());
        void (async () => {
          try {
            await latest.current.onStall();
          } catch {
            // Best-effort cancel.
          } finally {
            busyRef.current = false;
          }
        })();
        return;
      }

      if (action.type === 'resume') {
        const payload = latest.current.getResumePayload();
        if (!payload) {
          watchdogRef.current = disarmWatchdog();
          return;
        }
        watchdogRef.current = markResumed(watchdogRef.current, Date.now());
        latest.current.onNotice?.('resume', { resumeCount: watchdogRef.current.resumeCount });
        driveSend(payload);
        return;
      }

      // giveup — stop hang recovery (compliance caps handle the rest)
      watchdogRef.current = disarmWatchdog();
    }, TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [driveSend]);

  // Reset on conversation change.
  useEffect(() => {
    return () => {
      watchdogRef.current = disarmWatchdog();
      complianceRef.current = createInitialComplianceState();
      bufferRef.current = '';
    };
  }, [conversation_id]);
};
