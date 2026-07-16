/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CLI-agent conversation driver — the stateless "ask a CLI agent one question
 * and get its text answer" primitive that lets background AI surfaces (browser
 * web-agent, Studio, IDE, Make Video, Testing, Monitor…) run on a CLI agent
 * (Claude Code, Codex, Gemini CLI…) instead of an API-key provider.
 *
 * ## Why this exists
 *
 * Background surfaces talk to "the model" through a single non-streaming
 * `(messages) => Promise<string>` call. CLI agents have no such stateless API:
 * they only run inside a *conversation* (create → send → await turn → read
 * reply). This driver wraps that lifecycle so a CLI agent can satisfy the same
 * one-shot contract:
 *
 *   1. Create a fresh CLI conversation (temporary workspace) for the chosen
 *      agent id, OR reuse a pooled one (the runner may reuse across a ReAct loop
 *      so each step does not spawn a new CLI process).
 *   2. Flatten the OpenAI-style message array into a single prompt and
 *      `sendMessage`.
 *   3. Await the conversation's turn completion. The Main process cannot use the
 *      renderer WebSocket singleton, so completion is detected by a WS listener
 *      when available AND a REST poll fallback (whichever fires first).
 *   4. Read the agent's last assistant message as the answer.
 *
 * Everything is injected so the lifecycle is unit-testable without IPC.
 *
 * ## Process boundary
 *
 * Main-process (Node.js) module. No DOM APIs.
 */

import type { ChatMessageInput } from '@process/browser/webAgentRunner';

/** Resolved handle to a CLI conversation backing one driver session. */
export type CliConversationHandle = {
  /** Conversation id created/owned for this session. */
  conversationId: string;
  /** Whether the driver created it (and therefore should clean it up). */
  owned: boolean;
};

/** A turn-completion signal observed for a conversation. */
export type TurnSignal = {
  conversationId: string;
  /** True when the agent finished and can accept input again, or hit a terminal state. */
  finished: boolean;
  /** The agent's last message content (when carried by the signal). */
  content?: string;
};

/** Non-final activity observed for a conversation, e.g. token/tool/progress stream. */
export type ActivitySignal = {
  conversationId: string;
};

/** Injected collaborators for {@link createCliAgentDriver}. */
export type CliAgentDriverDeps = {
  /**
   * Create (or resolve) a CLI conversation for an agent id and return its
   * handle. Returns `null` when the agent id is unknown / not runnable.
   */
  createConversation: (agentId: string, modelId?: string) => Promise<CliConversationHandle | null>;
  /** Send the prompt (one turn) into a conversation. */
  sendMessage: (conversationId: string, prompt: string) => Promise<void>;
  /**
   * Subscribe to turn-completion signals for ALL conversations; the driver
   * filters by id. Returns an unsubscribe function. Optional — when omitted the
   * driver relies solely on {@link CliAgentDriverDeps.readLastAnswer} polling.
   */
  onTurnCompleted?: (listener: (signal: TurnSignal) => void) => () => void;
  /**
   * Subscribe to any non-final activity for ALL conversations. The driver uses
   * this as a watchdog heartbeat: long-running turns are allowed as long as the
   * backend keeps producing stream/tool/progress updates.
   */
  onActivity?: (listener: (signal: ActivitySignal) => void) => () => void;
  /**
   * Read the latest assistant answer for a conversation, or `null` when the turn
   * has not produced a final answer yet. Used both as the WS-path reader and as
   * the polling fallback.
   */
  readLastAnswer: (conversationId: string) => Promise<string | null>;
  /** Ask the backend to cancel an in-flight turn before failing the wrapper. */
  cancelConversation?: (conversationId: string) => Promise<void>;
  /** Delete a conversation the driver created (best-effort cleanup). */
  removeConversation?: (conversationId: string) => Promise<void>;
  /** Delay primitive (ms). Defaults to `setTimeout`. Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval (ms) for the REST fallback. Default 1500. */
  pollIntervalMs?: number;
  /** Upper bound (ms) for one turn before failing cleanly. Default 600000 (10 min). */
  timeoutMs?: number;
  /** Max silence (ms) during a running turn before treating it as stalled. Default 180000 (3 min). */
  idleTimeoutMs?: number;
};

/** A driver that runs one CLI-agent completion per call. */
export type CliAgentDriver = {
  /**
   * Run one completion: deliver `messages` to the CLI agent `agentId` and
   * resolve with its text answer. Rejects with a clear error on timeout,
   * cancellation, or when the agent is not runnable.
   */
  run: (params: {
    agentId: string;
    modelId?: string;
    messages: ChatMessageInput[];
    signal?: AbortSignal;
  }) => Promise<string>;
};

/** Default per-turn timeout (10 minutes) — CLI agents can run long tool loops. */
const DEFAULT_TIMEOUT_MS = 600_000;
/** Default max silence during a running turn. Progress/activity resets it. */
const DEFAULT_IDLE_TIMEOUT_MS = 180_000;
/** Default REST poll interval. */
const DEFAULT_POLL_INTERVAL_MS = 1_500;

const noopUnsubscribe = (): void => {};

/**
 * Flatten an OpenAI-style message array into a single prompt string for a CLI
 * agent. CLI agents take a plain instruction per turn (no role array), so we
 * render roles as labelled blocks and join multimodal text parts. Image parts
 * are summarised as a placeholder since CLI agents read text prompts.
 */
export const flattenMessagesToPrompt = (messages: ChatMessageInput[]): string => {
  const blocks: string[] = [];
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'Assistant' : message.role === 'system' ? 'System' : 'User';
    let text: string;
    if (typeof message.content === 'string') {
      text = message.content;
    } else {
      text = message.content
        .map((part) => (part.type === 'text' ? part.text : '[image omitted]'))
        .join('\n')
        .trim();
    }
    if (text.length === 0) continue;
    blocks.push(`### ${role}\n${text}`);
  }
  return blocks.join('\n\n').trim();
};

/**
 * Create a {@link CliAgentDriver} from injected collaborators. Each `run`
 * creates/resolves a conversation, sends the flattened prompt, awaits turn
 * completion (WS signal or REST poll, whichever first), reads the answer, and
 * cleans up an owned conversation.
 */
export const createCliAgentDriver = (deps: CliAgentDriverDeps): CliAgentDriver => {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  const run: CliAgentDriver['run'] = async ({ agentId, modelId, messages, signal }) => {
    if (signal?.aborted) throw new Error('CLI agent run cancelled.');

    const handle = await deps.createConversation(agentId, modelId);
    if (!handle) {
      throw new Error(`CLI agent "${agentId}" is not available. Open Settings and ensure the CLI is installed.`);
    }

    const prompt = flattenMessagesToPrompt(messages);
    if (prompt.length === 0) {
      if (handle.owned) await deps.removeConversation?.(handle.conversationId).catch((): void => undefined);
      throw new Error('Nothing to ask the CLI agent (empty prompt).');
    }

    try {
      const answer = await awaitAnswer(handle.conversationId, prompt, signal);
      return answer;
    } finally {
      if (handle.owned) {
        await deps.removeConversation?.(handle.conversationId).catch((): void => undefined);
      }
    }
  };

  /** Send the prompt then resolve with the first available answer (WS or poll). */
  const awaitAnswer = (conversationId: string, prompt: string, signal?: AbortSignal): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let unsubscribeTurn = noopUnsubscribe;
      let unsubscribeActivity = noopUnsubscribe;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (idleTimer) clearTimeout(idleTimer);
        unsubscribeTurn();
        unsubscribeActivity();
        if (signal) signal.removeEventListener('abort', onAbort);
        complete();
      };

      const failAndCancel = (message: string): void => {
        void deps.cancelConversation?.(conversationId).catch((): undefined => undefined);
        finish(() => reject(new Error(message)));
      };

      const armIdleTimer = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () =>
            failAndCancel(
              `CLI agent stalled: no activity for ${Math.ceil(idleTimeoutMs / 1000)}s. The turn was cancelled.`
            ),
          idleTimeoutMs
        );
      };

      const onAbort = (): void => failAndCancel('CLI agent run cancelled.');

      if (signal) {
        if (signal.aborted) {
          reject(new Error('CLI agent run cancelled.'));
          return;
        }
        signal.addEventListener('abort', onAbort);
      }

      // WS path: resolve as soon as the turn for this conversation completes.
      if (deps.onTurnCompleted) {
        unsubscribeTurn = deps.onTurnCompleted((sig) => {
          if (sig.conversationId !== conversationId || !sig.finished) return;
          void resolveFromSignal(sig)
            .then((answer) => finish(() => resolve(answer)))
            .catch(() => {
              /* poll loop still running as fallback */
            });
        });
      }

      // Activity path: long-running turns are fine while stream/tool/progress
      // updates keep arriving; silence past idleTimeoutMs is treated as stalled.
      if (deps.onActivity && idleTimeoutMs > 0) {
        unsubscribeActivity = deps.onActivity((activity) => {
          if (activity.conversationId !== conversationId || settled) return;
          armIdleTimer();
        });
      }

      // Timeout guard.
      timer = setTimeout(
        () => failAndCancel(`CLI agent did not respond within ${Math.round(timeoutMs / 1000)}s.`),
        timeoutMs
      );

      // Send the prompt, then start the REST poll fallback loop.
      deps
        .sendMessage(conversationId, prompt)
        .then(() => {
          armIdleTimer();
          return pollLoop(
            conversationId,
            () => settled,
            (answer) => finish(() => resolve(answer))
          );
        })
        .catch((error) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))));
    });
  };

  /** Resolve an answer from a WS signal, preferring its content, else reading it. */
  const resolveFromSignal = async (sig: TurnSignal): Promise<string> => {
    if (typeof sig.content === 'string' && sig.content.trim().length > 0) return sig.content;
    const read = await deps.readLastAnswer(sig.conversationId).catch((): null => null);
    if (typeof read === 'string' && read.trim().length > 0) return read;
    throw new Error('empty-signal');
  };

  /** REST poll fallback: read the last answer until it appears or we are settled. */
  const pollLoop = async (
    conversationId: string,
    isSettled: () => boolean,
    onAnswer: (answer: string) => void
  ): Promise<void> => {
    while (!isSettled()) {
      // Polling is intentionally sequential: one delayed read per interval.
      // eslint-disable-next-line no-await-in-loop
      await sleep(pollIntervalMs);
      if (isSettled()) return;
      // Polling is intentionally sequential: one delayed read per interval.
      // eslint-disable-next-line no-await-in-loop
      const answer = await deps.readLastAnswer(conversationId).catch((): null => null);
      if (typeof answer === 'string' && answer.trim().length > 0) {
        onAnswer(answer);
        return;
      }
    }
  };

  return { run };
};
