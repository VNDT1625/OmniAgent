/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { useCallback, useEffect, useRef } from 'react';
import {
  beginVerifying,
  createInitialRecoveryState,
  DEFAULT_RECOVERY_CONFIG,
  enterCooldown,
  evaluateRecovery,
  markRecovered,
  markResumeAttempt,
  recordActivity,
  startWatching,
  stopWatching,
  type RecoveryConfig,
  type RecoveryState,
} from './interruptionRecovery';

export type TurnRecoveryPayload = { input: string; files: string[] };

type RecoveryNotice = { retry: number; maxRetries: number; delayMs: number };

type UseAionrsTurnRecoveryOptions = {
  conversation_id: string;
  /** Whether the UI currently believes a turn is running (isBusy). */
  running: boolean;
  /** Recovery is only meaningful once the running state has been hydrated. */
  isHydrated: boolean;
  /**
   * Silently re-send a "continue" turn on the same conversation. The backend
   * keeps the conversation context, so a minimal continue prompt is enough to
   * pick up where the interrupted turn left off. Should resolve once the turn
   * has been (re)started.
   */
  resume: (payload: TurnRecoveryPayload) => Promise<void> | void;
  /**
   * Build the payload used to resume. Returning null disables recovery for this
   * turn (e.g. nothing to continue).
   */
  getResumePayload: () => TurnRecoveryPayload | null;
  /** Notify the UI that a retry has been scheduled after an interruption. */
  onRetryScheduled?: (notice: RecoveryNotice) => void;
  /** Notify the UI that a retry is being sent now. */
  onRetrying?: (notice: RecoveryNotice) => void;
  /** All retries exhausted — surface the interruption to the user. */
  onExhausted: () => void;
  config?: RecoveryConfig;
};

const TICK_INTERVAL_MS = 5_000;

/**
 * Renderer-driven recovery loop for aionrs turns. Watches the live stream for a
 * running turn; if activity stops without a normal completion AND the stop was
 * not user-initiated (confirmed by polling the backend), it silently re-sends a
 * continue turn with an escalating back-off, giving up only after the configured
 * cap is reached.
 *
 * Crucially, recovery decisions never depend on the send/stop button or on what
 * the user is typing — only on observed stream activity and the backend's own
 * reported liveness. This keeps the button free to reflect the real running
 * state while recovery runs independently underneath.
 */
export const useAionrsTurnRecovery = (options: UseAionrsTurnRecoveryOptions) => {
  const { conversation_id, running, isHydrated, config = DEFAULT_RECOVERY_CONFIG } = options;

  const stateRef = useRef<RecoveryState>(createInitialRecoveryState());
  // Set the moment the user clicks stop, so an in-flight stall check can never
  // mistake a deliberate cancel for an unintentional interruption.
  const userStoppedRef = useRef(false);
  // Guards the async liveness-check / resume so the ticker doesn't fire twice.
  const busyRef = useRef(false);
  const runningRef = useRef(running);

  const latest = useRef({
    resume: options.resume,
    getResumePayload: options.getResumePayload,
    onRetryScheduled: options.onRetryScheduled,
    onRetrying: options.onRetrying,
    onExhausted: options.onExhausted,
    config,
  });
  useEffect(() => {
    latest.current = {
      resume: options.resume,
      getResumePayload: options.getResumePayload,
      onRetryScheduled: options.onRetryScheduled,
      onRetrying: options.onRetrying,
      onExhausted: options.onExhausted,
      config,
    };
  }, [
    options.resume,
    options.getResumePayload,
    options.onRetryScheduled,
    options.onRetrying,
    options.onExhausted,
    config,
  ]);

  const createNotice = useCallback((): RecoveryNotice => {
    const retry = Math.min(stateRef.current.consecutiveRejections + 1, latest.current.config.maxConsecutiveRejections);
    return {
      retry,
      maxRetries: latest.current.config.maxConsecutiveRejections,
      delayMs: stateRef.current.cooldownDelayMs,
    };
  }, []);

  /** Called by the SendBox stop handler so recovery never fights a user cancel. */
  const notifyUserStop = useCallback(() => {
    userStoppedRef.current = true;
    stateRef.current = stopWatching();
  }, []);

  const fireResume = useCallback((payload: TurnRecoveryPayload) => {
    busyRef.current = true;
    stateRef.current = markResumeAttempt(stateRef.current, Date.now());
    void (async () => {
      try {
        await latest.current.resume(payload);
      } catch {
        // Best-effort: a failed resume is just another rejection; the next tick
        // will re-evaluate and escalate the back-off.
      } finally {
        busyRef.current = false;
      }
    })();
  }, []);

  // Single stream subscription: heartbeat + interruption detection.
  useEffect(() => {
    const unsubscribe = ipcBridge.conversation.responseStream.on((message) => {
      if (message.conversation_id !== conversation_id) return;

      // Any stream event is a heartbeat: the backend is alive and working.
      stateRef.current = recordActivity(stateRef.current, Date.now());

      if (message.type === 'error') {
        // The backend reported an error for this turn (e.g. provider/API-key
        // failure, network drop). If the user did not initiate a stop, treat it
        // as an unintentional interruption and queue a silent resume.
        if (!userStoppedRef.current && stateRef.current.phase === 'watching') {
          stateRef.current = enterCooldown(stateRef.current, Date.now(), latest.current.config);
          latest.current.onRetryScheduled?.(createNotice());
        }
      } else if (message.type === 'finish') {
        // A finish may be intermediate (tools still pending). The ticker's
        // liveness check is the source of truth for "really done", so we only
        // refresh the heartbeat here and let the watcher confirm via polling.
      }
    });
    return unsubscribe;
  }, [conversation_id]);

  // Turn-completion subscription: authoritative stop cause from the backend.
  useEffect(() => {
    const unsubscribe = ipcBridge.conversation.turnCompleted.on((event) => {
      if (event.session_id !== conversation_id) return;

      if (event.state === 'stopped') {
        // Deliberate stop (user or backend cancel) — never resume.
        stateRef.current = stopWatching();
        return;
      }
      if (event.state === 'ai_waiting_input') {
        // Normal completion — clear the rejection counter so the next genuine
        // interruption starts its back-off from zero.
        stateRef.current = markRecovered();
        return;
      }
      if (
        event.state === 'error' &&
        !userStoppedRef.current &&
        ['watching', 'verifying'].includes(stateRef.current.phase)
      ) {
        stateRef.current = enterCooldown(stateRef.current, Date.now(), latest.current.config);
        latest.current.onRetryScheduled?.(createNotice());
      }
    });
    return unsubscribe;
  }, [conversation_id]);

  // Arm/disarm watching as the running state flips.
  useEffect(() => {
    const wasRunning = runningRef.current;
    runningRef.current = running;
    if (!isHydrated) return;

    if (running && !wasRunning) {
      // A new turn started. If the user had stopped, this is a fresh user-driven
      // turn, so clear the stop flag and (re)start watching.
      userStoppedRef.current = false;
      stateRef.current = startWatching(stateRef.current, Date.now());
    } else if (!running && wasRunning) {
      // The UI says the turn ended, but this is NOT enough to prove the work
      // completed cleanly. In real provider/API-key/network interruptions the
      // stream can end and `running` can drop before any `error`/`turnCompleted`
      // signal arrives. The old behavior marked this as recovered immediately,
      // which is why the app stopped but never resumed. Instead, enter a short
      // verification grace period; a late clean `turnCompleted` will call
      // markRecovered(), otherwise the ticker polls the backend and resumes.
      if (stateRef.current.phase === 'watching') {
        stateRef.current = beginVerifying(stateRef.current, Date.now());
      }
    }
  }, [running, isHydrated]);

  // Recovery ticker: confirm liveness on stall, then resume with back-off.
  useEffect(() => {
    const timer = setInterval(() => {
      if (busyRef.current) return;
      const action = evaluateRecovery(stateRef.current, Date.now(), latest.current.config);
      if (action.type === 'none') return;

      if (action.type === 'check-liveness') {
        busyRef.current = true;
        void (async () => {
          try {
            const res = await getConversationOrNull(conversation_id);
            // Still running on the backend → not a real stall, just quiet work.
            if (res?.status === 'running') {
              stateRef.current = recordActivity(stateRef.current, Date.now());
              return;
            }
            // Backend is no longer running this turn and the user did not stop it
            // → unintentional interruption. Queue a silent resume.
            if (!userStoppedRef.current && ['watching', 'verifying'].includes(stateRef.current.phase)) {
              stateRef.current = enterCooldown(stateRef.current, Date.now(), latest.current.config);
              latest.current.onRetryScheduled?.(createNotice());
            }
          } catch {
            // The liveness poll itself failed (backend unreachable). Treat as an
            // interruption unless the user deliberately stopped.
            if (!userStoppedRef.current && ['watching', 'verifying'].includes(stateRef.current.phase)) {
              stateRef.current = enterCooldown(stateRef.current, Date.now(), latest.current.config);
              latest.current.onRetryScheduled?.(createNotice());
            }
          } finally {
            busyRef.current = false;
          }
        })();
        return;
      }

      if (action.type === 'resume') {
        const payload = latest.current.getResumePayload();
        if (!payload) {
          stateRef.current = stopWatching();
          return;
        }
        latest.current.onRetrying?.(createNotice());
        fireResume(payload);
        return;
      }

      if (action.type === 'giveup') {
        stateRef.current = stopWatching();
        latest.current.onExhausted();
      }
    }, TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [conversation_id, fireResume]);

  // Reset all recovery state when the conversation changes.
  useEffect(() => {
    stateRef.current = createInitialRecoveryState();
    userStoppedRef.current = false;
    busyRef.current = false;
    return () => {
      stateRef.current = createInitialRecoveryState();
    };
  }, [conversation_id]);

  return { notifyUserStop };
};
