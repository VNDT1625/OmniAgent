/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared "agent chat" service — lets background AI surfaces run on either an
 * API-key provider model OR a CLI agent (Claude Code, Codex, Gemini CLI…),
 * selected by an opaque `model` string (`cli:<agentId>` → CLI agent).
 *
 * Public surface:
 *  - {@link withCliAgent} — wrap an `AgentChat` (browser/editor runner style).
 *  - {@link runAgentChatMessages} — one-shot helper for the bridges that call a
 *    flat `(model, messages) => Promise<string>` (Studio, IDE, Make Video,
 *    Testing, Monitor, Company). Routes CLI ids to the driver and delegates
 *    provider ids to the injected provider runner.
 *  - {@link isCliModelId} / {@link makeCliModelId} / {@link parseCliModelId} —
 *    the model-id encoding helpers.
 *
 * Process boundary: Main-process (Node.js) modules. No DOM APIs.
 */

export { CLI_MODEL_PREFIX, isCliModelId, makeCliModelId, parseCliModelId } from './cliModelId';
export { withCliAgent, __resetSharedCliDriver } from './cliAgentChat';
export { createCliAgentDriver, flattenMessagesToPrompt } from './cliAgentDriver';
export { normalizeChatMessagesForMarkdown } from './markdownMessageNormalizer';
export type { CliAgentDriver, CliAgentDriverDeps, CliConversationHandle, TurnSignal } from './cliAgentDriver';
export type { MarkdownMessageNormalizerDeps } from './markdownMessageNormalizer';

import type { AgentChat, ChatMessageInput } from '@process/browser/webAgentRunner';
import { withCliAgent } from './cliAgentChat';

/** A flat completion call shared by the non-runner bridges. */
export type FlatChat = (model: string, messages: ChatMessageInput[], signal?: AbortSignal) => Promise<string>;

/**
 * One-shot helper for bridges that expose a flat `(model, messages)` chat. It
 * adapts the flat provider runner into an {@link AgentChat}, wraps it with CLI
 * routing, and invokes it once. CLI model ids (`cli:<agentId>`) are driven via
 * a CLI agent; all other ids fall through to `providerRun` unchanged.
 *
 * @param providerRun The surface's existing provider-backed flat chat.
 * @param model       The selected model id (provider model name or `cli:<id>`).
 * @param messages    The conversation messages for this single turn.
 * @param signal      Optional cancellation signal.
 */
export const runAgentChatMessages = (
  providerRun: FlatChat,
  model: string,
  messages: ChatMessageInput[],
  signal?: AbortSignal
): Promise<string> => {
  const adapted: AgentChat = ({ model: m, messages: msgs, signal: s }) => providerRun(m, msgs as ChatMessageInput[], s);
  return withCliAgent(adapted)({ model, messages, signal });
};
