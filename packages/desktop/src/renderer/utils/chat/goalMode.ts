/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { GOAL_TURN_REMINDER } from '@/common/chat/slash/goalSteering';
import type { GoalCommandVariant } from '@/common/chat/slash/goalCommand';

/**
 * Per-conversation "Goal Mode" state, persisted in localStorage so it survives
 * reloads and applies to every turn of that conversation until turned off.
 */

const GOAL_MODE_PREFIX = 'aionui.goal.mode.';

export type GoalModeState = {
  variant: GoalCommandVariant;
  /** The original requirement, kept for reference/diagnostics. */
  requirement: string;
  /** When Goal Mode was activated (ms). */
  startedAt: number;
};

const keyFor = (conversationId: string): string => `${GOAL_MODE_PREFIX}${conversationId}`;

export const getGoalMode = (conversationId: string): GoalModeState | null => {
  if (!conversationId) return null;
  try {
    const raw = localStorage.getItem(keyFor(conversationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GoalModeState>;
    if (parsed && (parsed.variant === 'goal' || parsed.variant === 'goal-all')) {
      return {
        variant: parsed.variant,
        requirement: typeof parsed.requirement === 'string' ? parsed.requirement : '',
        startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : Date.now(),
      };
    }
    return null;
  } catch {
    return null;
  }
};

export const isGoalModeActive = (conversationId: string): boolean => getGoalMode(conversationId) !== null;

export const setGoalMode = (conversationId: string, variant: GoalCommandVariant, requirement: string): void => {
  if (!conversationId) return;
  try {
    const state: GoalModeState = { variant, requirement, startedAt: Date.now() };
    localStorage.setItem(keyFor(conversationId), JSON.stringify(state));
  } catch {
    // Non-fatal: Goal Mode persistence is best-effort.
  }
};

export const clearGoalMode = (conversationId: string): void => {
  if (!conversationId) return;
  try {
    localStorage.removeItem(keyFor(conversationId));
  } catch {
    // Non-fatal.
  }
};

/**
 * Prepend the binding Goal Mode steering reminder to an ordinary turn while Goal
 * Mode is active for this conversation. Returns the input unchanged when:
 *  - Goal Mode is off,
 *  - the message is empty, or
 *  - the message is a slash command / already starts with the goal steering
 *    (e.g. the activating `/goal X` turn, whose expansion already carries the
 *    full pipeline) — avoids double-injection.
 */
export const withGoalSteeringDirective = (modelInput: string, conversationId: string): string => {
  const trimmed = modelInput.trim();
  if (trimmed.length === 0) return modelInput;
  if (trimmed.startsWith('/')) return modelInput;
  if (trimmed.startsWith('[GOAL MODE') || trimmed.startsWith('[GOAL-ALL MODE') || trimmed.startsWith('MỤC TIÊU (GOAL'))
    return modelInput;
  if (!isGoalModeActive(conversationId)) return modelInput;
  return `${GOAL_TURN_REMINDER}\n\n${modelInput}`;
};
