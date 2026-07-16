/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-conversation independent verification command for Goal Mode.
 *
 * When set, the renderer runs this command in the workspace when the agent
 * claims the goal is done — and only accepts completion if it exits 0. This
 * stops the agent from "self-certifying" (claiming tests=pass without proof).
 * Opt-in (the user sets it via `/goal verify <command>`) so no arbitrary command
 * ever runs without explicit user intent.
 */

const GOAL_VERIFY_PREFIX = 'aionui.goal.verify.';

const keyFor = (conversationId: string): string => `${GOAL_VERIFY_PREFIX}${conversationId}`;

export const getGoalVerifyCommand = (conversationId: string): string | null => {
  if (!conversationId) return null;
  try {
    const raw = localStorage.getItem(keyFor(conversationId));
    return raw && raw.trim().length > 0 ? raw : null;
  } catch {
    return null;
  }
};

export const setGoalVerifyCommand = (conversationId: string, command: string): void => {
  if (!conversationId) return;
  try {
    localStorage.setItem(keyFor(conversationId), command);
  } catch {
    // Non-fatal.
  }
};

export const clearGoalVerifyCommand = (conversationId: string): void => {
  if (!conversationId) return;
  try {
    localStorage.removeItem(keyFor(conversationId));
  } catch {
    // Non-fatal.
  }
};
