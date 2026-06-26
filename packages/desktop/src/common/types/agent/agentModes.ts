/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { CODEX_MODE_NATIVE_FULL_ACCESS, CODEX_MODE_READ_ONLY } from '@/common/types/codex/codexModes';

/**
 * Full-auto (YOLO) mode ID per backend.
 * Shared by renderer (cron task creation) and process (SessionLifecycle).
 */
const FULL_AUTO_MODE: Record<string, string> = {
  claude: 'bypassPermissions',
  qwen: 'yolo',
  opencode: 'build',
  gemini: 'yolo',
  aionrs: 'yolo',
  codex: CODEX_MODE_NATIVE_FULL_ACCESS,
  cursor: 'agent',
  snow: 'yolo',
  deepseek: 'yolo',
  antigravity: 'yolo',
};

/**
 * Get the full-auto mode value for a given backend.
 * Falls back to 'yolo' for unknown backends.
 */
export function getFullAutoMode(backend: string | undefined): string {
  if (!backend) return 'yolo';
  return FULL_AUTO_MODE[backend] || 'yolo';
}

/**
 * "Ask-before-acting" mode ID per backend — the OPPOSITE of {@link FULL_AUTO_MODE}.
 *
 * Strict IDE Mode (Layer 1) forces a conversation onto this mode so the backend
 * raises a `session/request_permission` for every tool call instead of running
 * it silently. Without this, a YOLO/bypass session never asks, and the renderer
 * auto-deny guard (Layer 2) would have nothing to intercept.
 *
 * Values are the most restrictive "prompt me" mode each backend advertises in
 * `AGENT_MODES` (see renderer/utils/model/agentModes.ts).
 */
const ASK_MODE: Record<string, string> = {
  claude: 'default',
  qwen: 'default',
  opencode: 'plan',
  gemini: 'default',
  aionrs: 'default',
  codex: CODEX_MODE_READ_ONLY,
  cursor: 'ask',
  snow: 'default',
  deepseek: 'default',
  antigravity: 'default',
};

/**
 * Get the "ask-before-acting" mode value for a given backend, used to force a
 * permission prompt under Strict IDE Mode. Returns `undefined` for unknown
 * backends so the caller can leave the mode untouched.
 */
export function getAskMode(backend: string | undefined): string | undefined {
  if (!backend) return undefined;
  return ASK_MODE[backend];
}
