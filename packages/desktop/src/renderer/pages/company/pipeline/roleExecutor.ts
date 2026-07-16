/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Role executor — runs a role's task **for real** (Requirement 3).
 *
 * "For real" means: the role's assigned executor (a CLI agent like Claude Code,
 * or a preset assistant) runs inside a real conversation with a real workspace,
 * so it reads/writes files, runs commands, and produces actual output — not a
 * model merely describing what it would do.
 *
 * Mechanism (all of these already exist in the app; nothing in aioncore changes):
 *   1. Resolve/create a conversation for the role (CLI/assistant params + workspace).
 *   2. `sendMessage({ conversation_id, input: task })`.
 *   3. Await the `turn.completed` event for that conversation → `state: 'finished'`
 *      && `can_send_message`; read `last_message.content` as the result.
 *   4. Lease an `agent` slot around the turn (Requirement 3.5) and enforce a
 *      timeout / cancellation so a stuck agent never blocks the whole run (3.6).
 *
 * Every collaborator is injected so this is unit-testable without IPC.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

/** Outcome of a real execution turn. */
export type ExecuteOutcome =
  | { ok: true; result: string; conversationId: string; workspace: string; simulated?: boolean }
  | { ok: false; error: string; conversationId?: string };

/** A granted lease handle (structural subset of the ResourceCoordinator's). */
export type ExecutorLease = { id: string };

/** The injected collaborators the executor drives. */
export type RoleExecutorDeps = {
  /**
   * Resolve (or create) the conversation backing a role and return its id +
   * workspace. Implemented over `companySession` + `ipcBridge.conversation`.
   * Returns `null` when the role has no runnable executor assigned.
   */
  resolveConversation: (input: {
    nodeId: string;
    briefing: string;
  }) => Promise<{ conversationId: string; workspace: string } | null>;
  /** Send a message (the task) into a conversation. */
  sendMessage: (input: { conversationId: string; content: string }) => Promise<void>;
  /**
   * Subscribe to turn-completed events. Must invoke `listener` for EVERY turn;
   * the executor filters by conversation id. Returns an unsubscribe function.
   */
  onTurnCompleted: (
    listener: (event: { conversationId: string; finished: boolean; content: string }) => void
  ) => () => void;
  /** Acquire an `agent` lease (queues until budget frees). Optional. */
  requestLease?: (req: { kind: 'agent'; estCostMB: number }) => Promise<ExecutorLease>;
  /** Release a previously acquired lease. Optional (paired with requestLease). */
  releaseLease?: (id: string) => void;
  /**
   * Fallback when no real executor is assigned: produce a (simulated) result via
   * model chat. Optional; when absent, the executor reports a clear error.
   */
  simulate?: (input: { nodeId: string; briefing: string; task: string }) => Promise<string>;
  /** Clock for timeouts (ms). Defaults to a real timer. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Clear a timer created with `setTimer`. */
  clearTimer?: (handle: unknown) => void;
};

/** Per-call options. */
export type ExecuteOptions = {
  /** Role node id being executed. */
  nodeId: string;
  /** The composed briefing (company + division + rules + soul) for the role. */
  briefing: string;
  /** The concrete task to perform. */
  task: string;
  /** Timeout (ms) before the turn is abandoned. Default 600000 (10 min). */
  timeoutMs?: number;
  /** Estimated RAM (MB) charged to the lease. Default 384. */
  estCostMB?: number;
  /** External cancellation. */
  signal?: AbortSignal;
};

/** Default execution timeout (10 minutes). */
const DEFAULT_TIMEOUT_MS = 600000;
/** Default per-turn RAM estimate. */
const DEFAULT_EST_COST_MB = 384;

/**
 * Run one role's task for real and resolve with its output.
 *
 * Never rejects on an operational failure (timeout, abort, missing executor):
 * those resolve with `{ ok: false }` so the recursive runner can surface the
 * error up the tree without crashing the whole run.
 */
export const executeViaConversation = async (
  deps: RoleExecutorDeps,
  options: ExecuteOptions
): Promise<ExecuteOutcome> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const estCostMB = options.estCostMB ?? DEFAULT_EST_COST_MB;

  // Resolve the role's real conversation. No executor → simulate or error.
  const resolved = await deps
    .resolveConversation({ nodeId: options.nodeId, briefing: options.briefing })
    .catch((): null => null);
  if (!resolved) {
    if (deps.simulate) {
      try {
        const result = await deps.simulate({ nodeId: options.nodeId, briefing: options.briefing, task: options.task });
        return { ok: true, result, conversationId: '', workspace: '', simulated: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return { ok: false, error: 'No runnable executor is assigned to this role.' };
  }

  const { conversationId, workspace } = resolved;

  // Lease an agent slot for the duration of the turn (Requirement 3.5).
  let lease: ExecutorLease | undefined;
  if (deps.requestLease) {
    lease = await deps.requestLease({ kind: 'agent', estCostMB });
  }

  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  try {
    const outcome = await new Promise<ExecuteOutcome>((resolve) => {
      let settled = false;
      let unsubscribe = (): void => {};
      let timer: unknown;

      const finish = (result: ExecuteOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        unsubscribe();
        if (options.signal) options.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const onAbort = (): void => finish({ ok: false, error: 'Execution cancelled.', conversationId });

      if (options.signal) {
        if (options.signal.aborted) {
          finish({ ok: false, error: 'Execution cancelled.', conversationId });
          return;
        }
        options.signal.addEventListener('abort', onAbort);
      }

      // Listen for this conversation's turn completion before sending.
      unsubscribe = deps.onTurnCompleted((event) => {
        if (event.conversationId !== conversationId || !event.finished) return;
        finish({ ok: true, result: event.content ?? '', conversationId, workspace });
      });

      // Arm the timeout.
      timer = setTimer(
        () => finish({ ok: false, error: `Execution timed out after ${timeoutMs} ms.`, conversationId }),
        timeoutMs
      );

      // Send the task; a send failure resolves as an error (never hangs).
      deps
        .sendMessage({ conversationId, content: options.task })
        .catch((error) =>
          finish({ ok: false, error: error instanceof Error ? error.message : String(error), conversationId })
        );
    });

    return outcome;
  } finally {
    if (lease && deps.releaseLease) deps.releaseLease(lease.id);
  }
};
