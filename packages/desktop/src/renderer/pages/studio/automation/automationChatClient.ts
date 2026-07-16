/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the Automation Chat (AI Workflow Designer) IPC
 * surface. Mirrors `automationClient.ts`: re-declares the channel name and
 * rebuilds a `bridge.buildProvider` invoker, borrowing only types via
 * `import type`.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type {
  AutomationChatReply,
  AutomationChatRequest,
  AutomationChatResult,
} from '@process/automation/automationChatBridge';

/** Automation chat channel name (mirror of `AUTOMATION_CHAT_CHANNELS`). */
const AUTOMATION_CHAT_CHANNELS = {
  chat: 'automation.chat',
} as const;

/** Long timeout (ms) — the AI completion can take a while. */
const CHAT_TIMEOUT_MS = 120000;

const channel = bridge.buildProvider<AutomationChatResult<AutomationChatReply>, AutomationChatRequest>(
  AUTOMATION_CHAT_CHANNELS.chat
);

/** Error thrown when the chat call does not reply within its budget. */
export class AutomationChatTimeoutError extends Error {
  constructor() {
    super('[AutomationChatClient] No reply on "automation.chat" — the bridge may not be wired yet.');
    this.name = 'AutomationChatTimeoutError';
  }
}

/** Race an invoke against a timeout so an unwired bridge rejects fast. */
const invokeWithTimeout = (req: AutomationChatRequest): Promise<AutomationChatResult<AutomationChatReply>> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new AutomationChatTimeoutError());
    }, CHAT_TIMEOUT_MS);
    channel.invoke(req).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

/** Timeout-guarded Automation chat invoker for the renderer. */
export const automationChatClient = {
  chat: (req: AutomationChatRequest): Promise<AutomationChatResult<AutomationChatReply>> => invokeWithTimeout(req),
};

export type { AutomationChatReply, AutomationChatRequest };
