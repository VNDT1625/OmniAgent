/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useAutomationChat` — state + actions for the AI Workflow Designer panel.
 *
 * Owns a small transcript (user/assistant turns) and sends each turn to the
 * `automation.chat` bridge with the current workflow + an intent hint. When the
 * AI returns a workflow, the hook surfaces it via `onWorkflowChanged` so the
 * editor can switch to it.
 *
 * Renderer-only.
 */

import { useCallback, useRef, useState } from 'react';
import { automationChatClient, type AutomationChatRequest } from './automationChatClient';
import type { Workflow } from './automationClient';

/** A rendered transcript line. */
export type ChatLine = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

/** Failure arm of the result envelope (no-strictNullChecks cast target). */
type ChatFailure = { ok: false; error: string; code: 'no-model' | 'error' };

/** Public shape returned by {@link useAutomationChat}. */
export type UseAutomationChat = {
  lines: ChatLine[];
  busy: boolean;
  error: string | null;
  send: (text: string, intent: AutomationChatRequest['intent']) => Promise<void>;
  clear: () => void;
};

let lineSeq = 0;
const nextLineId = (): string => `cl${Date.now().toString(36)}-${(lineSeq++).toString(36)}`;

/**
 * Manage the AI Workflow Designer chat.
 *
 * @param params.model The model id to run the designer with.
 * @param params.getCurrentWorkflow Returns the workflow currently open (context).
 * @param params.getExistingWorkflows Returns {id,name} of all workflows (avoid dupes).
 * @param params.onWorkflowChanged Called when the AI created/edited a workflow.
 */
export const useAutomationChat = (params: {
  model: string;
  getCurrentWorkflow: () => Workflow | null;
  getExistingWorkflows: () => Array<{ id: string; name: string }>;
  onWorkflowChanged: (workflow: Workflow) => void;
}): UseAutomationChat => {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep the running message list (system-free) for multi-turn context.
  const historyRef = useRef<Array<{ role: 'user' | 'assistant'; content: string }>>([]);

  const send = useCallback(
    async (text: string, intent: AutomationChatRequest['intent']): Promise<void> => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || busy) return;
      setError(null);
      setBusy(true);

      const userLine: ChatLine = { id: nextLineId(), role: 'user', content: trimmed };
      setLines((prev) => [...prev, userLine]);
      historyRef.current = [...historyRef.current, { role: 'user', content: trimmed }];

      try {
        const result = await automationChatClient.chat({
          model: params.model,
          messages: historyRef.current,
          currentWorkflow: params.getCurrentWorkflow(),
          existingWorkflows: params.getExistingWorkflows(),
          intent,
        });

        if (!result.ok) {
          setError((result as ChatFailure).error);
          return;
        }

        const { reply, workflow } = result.data;
        const assistantLine: ChatLine = { id: nextLineId(), role: 'assistant', content: reply };
        setLines((prev) => [...prev, assistantLine]);
        historyRef.current = [...historyRef.current, { role: 'assistant', content: reply }];

        if (workflow) params.onWorkflowChanged(workflow);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, params]
  );

  const clear = useCallback((): void => {
    setLines([]);
    historyRef.current = [];
    setError(null);
  }, []);

  return { lines, busy, error, send, clear };
};

export default useAutomationChat;
