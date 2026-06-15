/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer state for the web-agent chat panel (Requirement 1, criterion 1.2).
 *
 * This hook is a thin React binding over the module-level {@link agentChatStore}
 * singleton. The store — not this hook — owns the per-tab transcripts and the
 * "is a turn running" flag, and subscribes to the Main → renderer agent-event
 * stream **always-on**. That is what makes a web-agent turn keep working when
 * the user leaves the Browser page: the runner lives in the Main process and
 * keeps going, the store keeps capturing its narration/answers while the page
 * is unmounted, and the transcript is intact (and even survives a reload via a
 * sessionStorage mirror) when the user returns.
 *
 * Each chat message is one of:
 *  - `user`      — what the user typed,
 *  - `assistant` — the agent's final answer for a turn,
 *  - `step`      — a single tool action + its observation (the live narration),
 *  - `error`     — a failed turn.
 *
 * Renderer-only module: talks to the Main process exclusively via the store /
 * typed `browserClient`; no Node.js APIs.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { agentChatStore, type ChatMessage } from './agentChatStore';

export type { ChatMessage };

/** Status of the agent for the active tab. */
export type AgentChatStatus = 'idle' | 'running';

/** Public shape returned by {@link useAgentChat}. */
export type UseAgentChat = {
  /** Transcript for the active tab. */
  messages: ChatMessage[];
  /** Whether a turn is currently running. */
  status: AgentChatStatus;
  /** Send an instruction to the agent for the active tab. `interactive` grants control of the visible tab. */
  send: (instruction: string, interactive?: boolean) => Promise<void>;
  /** Stop the in-flight turn. */
  stop: () => void;
  /** Clear the transcript for the active tab. */
  clear: () => void;
};

/** Empty transcript reused so idle tabs share one stable reference. */
const EMPTY_MESSAGES: ChatMessage[] = [];

/**
 * Bind the web-agent chat for the currently active tab to the shared store.
 *
 * @param activeTabId The tab the chat drives, or null when no tab is open.
 * @param agentModel  The model id the user picked to power the agent.
 */
export function useAgentChat(activeTabId: string | null, agentModel: string | null): UseAgentChat {
  const state = useSyncExternalStore(agentChatStore.subscribe, agentChatStore.getState);

  const messages = useMemo(
    () => (activeTabId ? (state.transcripts[activeTabId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES),
    [activeTabId, state.transcripts]
  );
  const status: AgentChatStatus =
    state.runningTabId !== null && state.runningTabId === activeTabId ? 'running' : 'idle';

  const send = useCallback(
    async (instruction: string, interactive?: boolean) => {
      if (!activeTabId || !agentModel) return;
      await agentChatStore.send(activeTabId, agentModel, instruction, interactive ?? false);
    },
    [activeTabId, agentModel]
  );

  const stop = useCallback(() => {
    if (activeTabId) agentChatStore.stop(activeTabId);
  }, [activeTabId]);

  const clear = useCallback(() => {
    if (activeTabId) agentChatStore.clear(activeTabId);
  }, [activeTabId]);

  return { messages, status, send, stop, clear };
}
