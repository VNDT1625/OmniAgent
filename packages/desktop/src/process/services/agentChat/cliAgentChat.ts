/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `withCliAgent` — the drop-in wrapper that lets ANY background AI surface run
 * on a CLI agent (Claude Code, Codex, Gemini CLI…) when the user picks one,
 * while leaving the existing API-provider path untouched for normal model ids.
 *
 * Background surfaces resolve "the model" by a single `model: string`. We encode
 * a CLI choice as `cli:<agentId>` (see {@link ./cliModelId}). Wrap a surface's
 * existing `AgentChat` once:
 *
 * ```ts
 * const chat = withCliAgent(createProviderChat());
 * ```
 *
 * - `model` is `cli:<agentId>`  → drive the CLI agent via {@link createCliAgentDriver}.
 * - any other `model`           → delegate to the wrapped provider chat unchanged.
 *
 * The CLI driver is created lazily and shared, wired to aioncore over the
 * Main-process REST client (`ipcBridge`) plus the Main-process backend WS
 * listener for fast turn-completion (with REST polling as a fallback, since the
 * shared renderer WS singleton does not run in the Main process).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { ipcBridge } from '@/common';
import type { AgentMetadata } from '@/renderer/utils/model/agentTypes';
import { buildAgentConversationParams, resolveAgentBackendKey } from '@/common/utils/buildAgentConversationParams';
import type { TProviderWithModel } from '@/common/config/storage';
import type { AgentChat, ChatMessageInput } from '@process/browser/webAgentRunner';
import { parseCliModelId } from './cliModelId';
import {
  createCliAgentDriver,
  type CliAgentDriver,
  type CliConversationHandle,
  type TurnSignal,
} from './cliAgentDriver';
import { subscribeBackendEvent } from './mainBackendWs';
import { normalizeChatMessagesForMarkdown } from './markdownMessageNormalizer';

/** Resolve the detected CLI agents from aioncore (`GET /api/agents`). */
const listAgents = async (): Promise<AgentMetadata[]> => {
  const agents = await ipcBridge.acpConversation.getAvailableAgents.invoke().catch(() => [] as AgentMetadata[]);
  return Array.isArray(agents) ? (agents as AgentMetadata[]) : [];
};

/** Find a runnable agent by id / agent_type / backend (matching the company resolver). */
const findRunnableAgent = (agents: AgentMetadata[], agentId: string): AgentMetadata | null => {
  const match = agents.find(
    (a) => a.available !== false && (a.id === agentId || a.agent_type === agentId || a.backend === agentId)
  );
  return match ?? null;
};

/**
 * Read the latest assistant answer for a conversation over REST. Reads the most
 * recent messages (newest first) and returns the first assistant/`left` text
 * message's content, or `null` when none has been produced yet.
 */
const readLastAnswer = async (conversationId: string): Promise<string | null> => {
  const page = await ipcBridge.database.getConversationMessages
    .invoke({ conversation_id: conversationId, page: 1, page_size: 20, order: 'desc', content_mode: 'full' })
    .catch((): null => null);
  const items = page?.items;
  if (!Array.isArray(items)) return null;
  for (const message of items) {
    if (message.type !== 'text') continue;
    // Assistant replies render on the left; user messages on the right.
    if (message.position === 'right') continue;
    const content = (message.content as { content?: unknown } | undefined)?.content;
    if (typeof content === 'string' && content.trim().length > 0) return content;
  }
  return null;
};

/**
 * Build production driver deps. A fresh conversation is created per `run`
 * (stateless contract); it is removed afterwards. Turn completion is observed
 * via the Main-process backend WS (fast) and a REST poll fallback.
 */
const createProductionDriver = (): CliAgentDriver =>
  createCliAgentDriver({
    createConversation: async (agentId: string, modelId?: string): Promise<CliConversationHandle | null> => {
      const agents = await listAgents();
      const agent = findRunnableAgent(agents, agentId);
      if (!agent) return null;

      // CLI agents (ACP/codex/etc.) carry model info via `extra`, not the
      // top-level `model` slot, so an empty model object is correct here.
      const backend = resolveAgentBackendKey(agent);
      const params = buildAgentConversationParams({
        backend,
        name: `AionUi · ${agent.name}`,
        agent_id: agent.id,
        agent_name: agent.name,
        workspace: '',
        current_model_id: modelId,
        model: {} as TProviderWithModel,
      });

      const conversation = await ipcBridge.conversation.create.invoke(params).catch((): null => null);
      if (!conversation?.id) return null;
      return { conversationId: conversation.id, owned: true };
    },
    sendMessage: async (conversationId: string, prompt: string): Promise<void> => {
      await ipcBridge.conversation.sendMessage.invoke({ conversation_id: conversationId, input: prompt });
    },
    onTurnCompleted: (listener) =>
      subscribeBackendEvent('turn.completed', (payload): void => {
        const raw = (payload ?? {}) as Record<string, unknown>;
        const conversationId = (raw.session_id ?? raw.sessionId ?? raw.conversation_id ?? '') as string;
        if (!conversationId) return;
        const state = (raw.state ?? '') as string;
        const status = (raw.status ?? '') as string;
        const canSend = (raw.can_send_message ?? raw.canSendMessage ?? status === 'finished') as boolean;
        const terminal = state === 'ai_waiting_input' || state === 'stopped' || state === 'error';
        const rawLast = (raw.last_message ?? raw.lastMessage) as { content?: unknown } | undefined;
        const content = typeof rawLast?.content === 'string' ? rawLast.content : undefined;
        const signal: TurnSignal = { conversationId, finished: canSend === true || terminal, content };
        listener(signal);
      }),
    onActivity: (listener) =>
      subscribeBackendEvent('message.stream', (payload): void => {
        const raw = (payload ?? {}) as Record<string, unknown>;
        const conversationId = (raw.conversation_id ?? raw.conversationId ?? raw.session_id ?? raw.sessionId ?? '') as
          | string
          | undefined;
        if (!conversationId) return;
        listener({ conversationId });
      }),
    readLastAnswer,
    cancelConversation: async (conversationId: string): Promise<void> => {
      await ipcBridge.conversation.stop.invoke({ conversation_id: conversationId }).catch((): undefined => undefined);
    },
    removeConversation: async (conversationId: string): Promise<void> => {
      await ipcBridge.conversation.remove.invoke({ id: conversationId }).catch((): undefined => undefined);
    },
  });

let sharedDriver: CliAgentDriver | null = null;

/** Lazily build + cache the shared production CLI driver. */
const getDriver = (): CliAgentDriver => {
  if (!sharedDriver) sharedDriver = createProductionDriver();
  return sharedDriver;
};

/**
 * Wrap an existing {@link AgentChat} so that a `cli:<agentId>` model routes to a
 * CLI agent while every other model id delegates to `inner` unchanged.
 *
 * @param inner The provider-backed chat to fall back to (e.g. `createProviderChat()`).
 * @param driver Optional driver override (tests inject a stub).
 */
export const withCliAgent = (inner: AgentChat, driver?: CliAgentDriver): AgentChat => {
  return async ({ model, messages, signal }) => {
    const normalizedMessages = await normalizeChatMessagesForMarkdown(messages as ChatMessageInput[]);
    const cli = parseCliModelId(model);
    if (!cli) {
      return inner({ model, messages: normalizedMessages, signal });
    }
    const activeDriver = driver ?? getDriver();
    return activeDriver.run({
      agentId: cli.agentId,
      modelId: cli.modelId,
      messages: normalizedMessages,
      signal,
    });
  };
};

/** Reset the cached driver (tests / teardown). */
export const __resetSharedCliDriver = (): void => {
  sharedDriver = null;
};
