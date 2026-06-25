/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IDE inline-completion IPC bridge — the "Tab completion" plane. Given the code
 * BEFORE and AFTER the cursor, it asks the user's configured model to produce
 * the snippet to insert at the cursor (a fill-in-the-middle / FIM request), and
 * returns the raw code so the renderer can paint it as Monaco ghost text the
 * user accepts with Tab.
 *
 * One channel: `ide.inline-complete`. The renderer cannot call model providers
 * directly (CORS / `webSecurity`), so — like the wiki/explain bridges — the
 * completion is issued from the Main process via {@link runIdeChat}. The result
 * is wrapped in an always-resolving envelope so a miss (no model, network error)
 * never hangs the editor; it just yields no suggestion and the editor stays free.
 *
 * The model output is sanitised here: markdown code fences are stripped and the
 * insertion is capped, so the renderer can insert it verbatim.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { resolveDefaultModel, runIdeChat, type IdeChatMessage } from '../ideProvider';

/** IPC channel names for the IDE inline-completion surface (renderer-safe contract). */
export const IDE_COMPLETION_CHANNELS = {
  inlineComplete: 'ide.inline-complete',
} as const;

/** Request for {@link IDE_COMPLETION_CHANNELS.inlineComplete}. */
export type InlineCompleteRequest = {
  /** Code immediately before the cursor (already trimmed to a budget by the caller). */
  prefix: string;
  /** Code immediately after the cursor (already trimmed to a budget by the caller). */
  suffix: string;
  /** Monaco language id (e.g. `typescript`, `python`) — steers the model. */
  language: string;
  /** Absolute file path, for context only (optional). */
  filePath?: string;
  /** Explicit model id; when absent the first usable provider/model is used. */
  model?: string;
};

/** Always-resolving result envelope. */
export type IdeCompletionResult = { ok: true; data: string } | { ok: false; error: string };

/** Typed channel. Exported for bootstrap registration wiring. */
export const ideCompletionChannels = {
  inlineComplete: bridge.buildProvider<IdeCompletionResult, InlineCompleteRequest>(
    IDE_COMPLETION_CHANNELS.inlineComplete
  ),
};

/** Hard cap on the characters of context we send (keeps the call cheap + fast). */
const MAX_PREFIX = 4000;
const MAX_SUFFIX = 1000;
/** Hard cap on the suggestion length returned to the editor. */
const MAX_COMPLETION = 600;

/**
 * Strip markdown code fences a chat model often wraps code in, returning the raw
 * inner code. Leaves un-fenced output untouched.
 */
export const stripCodeFence = (text: string): string => {
  const trimmed = text.replace(/^\s+/, '').replace(/\s+$/, '');
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/;
  const match = fence.exec(trimmed);
  return match ? match[1] : trimmed;
};

/** Build the FIM chat messages for one completion request. */
export const buildCompletionMessages = (req: InlineCompleteRequest): IdeChatMessage[] => {
  const prefix = req.prefix.slice(-MAX_PREFIX);
  const suffix = req.suffix.slice(0, MAX_SUFFIX);
  return [
    {
      role: 'system',
      content:
        'You are an autocomplete engine inside a code editor. Given the code before and after the cursor, ' +
        'output ONLY the code to insert at the cursor position. Do not repeat the surrounding code. ' +
        'No explanations, no markdown code fences. Complete the current line or a small logical block. ' +
        'If there is nothing useful to insert, output nothing.',
    },
    {
      role: 'user',
      content: `Language: ${req.language}\n\n<|code_before|>\n${prefix}\n<|cursor|>${suffix}\n<|code_after_end|>\n\nInsert the code that should go at <|cursor|>.`,
    },
  ];
};

/** Run one inline completion, resolving the model lazily. Throws on failure. */
const inlineComplete = async (req: InlineCompleteRequest): Promise<string> => {
  if (!req.prefix && !req.suffix) return '';
  // A `cli:<agent>` model would spawn a CLI agent per keystroke — far too slow
  // for ghost text. Force a provider model for completion.
  const requested = req.model && !req.model.startsWith('cli:') ? req.model : undefined;
  const model = requested ?? (await resolveDefaultModel());
  if (!model) return '';
  const raw = await runIdeChat(model, buildCompletionMessages(req));
  return stripCodeFence(raw).slice(0, MAX_COMPLETION);
};

/**
 * Register the IDE inline-completion IPC handler. Idempotent. Intended to be
 * called once during Main-process bootstrap.
 */
export function registerIdeCompletionBridge(): void {
  ideCompletionChannels.inlineComplete.provider(async (req): Promise<IdeCompletionResult> => {
    try {
      return { ok: true, data: await inlineComplete(req) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
