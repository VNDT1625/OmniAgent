/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Company pipeline facade — wires the recursive runner, planner, real executor,
 * approval gate, and test gate to the live app services, and feeds the event
 * stream into a {@link PipelineStore}.
 *
 * This is the single entry point the Manager popup's "Pipeline (real work)" mode
 * uses: `runCompany({...})` starts a recursive run rooted at the President;
 * `approve` / `stop` drive it from the UI. All app I/O lives here (model chat,
 * conversation create/send, turn-completed subscription, lease, testing client)
 * so the runner/planner/executor stay pure and unit-testable.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { ipcBridge } from '@/common';
import type { CompanyStructure, RoleNode } from '@process/company/companyOrchestrator';
import { openRoleChat, loadCompanyRoleConversations, saveCompanyRoleConversation } from '../companySession';
import { testingClient } from '@/renderer/pages/testing/testingBridgeClient';
import { recommendedConcurrency } from '@/renderer/utils/hardwareConcurrency';
import { createPipelineChat } from './pipelineChat';
import { composeSoul, directReportsOf, findRoleNode } from './soulComposer';
import { createApprovalGate, type IApprovalGate } from './approvalGate';
import { executeViaConversation, type RoleExecutorDeps } from './roleExecutor';
import { runTestGate } from './testGate';
import { createRoleRunner, type RoleMind } from './roleRunner';
import type { PipelineStore } from './pipelineStore';
import type { ApprovalDecision, RoleRunState, RunConfig } from './pipelineTypes';

/** A running company handle the UI controls. */
export type CompanyRunHandle = {
  /** The run id. */
  runId: string;
  /** Approve/deny a pending approval or permission. */
  resolveApproval: (decision: ApprovalDecision) => void;
  /** Cancel the run (abort + release + deny pending). */
  stop: () => void;
  /** The promise that settles when the run finishes. */
  done: Promise<void>;
};

/** Input to {@link runCompany}. */
export type RunCompanyInput = {
  /** Company id. */
  companyId: string;
  /** Company display name. */
  companyName: string;
  /** The built structure to run. */
  structure: CompanyStructure;
  /** Company rules. */
  rules: string[];
  /** Top-level goal for the President. */
  goal: string;
  /** Model id to run planning/synthesis with (optional). */
  model?: string;
  /** UI language (forwarded to executor conversation creation). */
  language: string;
  /** Tunables. */
  config?: RunConfig;
  /** Store to feed events into. */
  store: PipelineStore;
};

/** Default model-chat for planning/synthesis (provider-backed, renderer-side). */
const createPlannerChat = () => createPipelineChat();

/** Flatten a structure into initial role states (for the tree board). */
const initialStates = (structure: CompanyStructure): RoleRunState[] => {
  const out: RoleRunState[] = [];
  const walk = (node: RoleNode, parentId?: string): void => {
    out.push({ nodeId: node.id, name: node.name, role: node.role, parentId, activity: 'idle', updatedAt: Date.now() });
    for (const child of node.children) walk(child, node.id);
  };
  walk(structure.root);
  return out;
};

/** Find a role node by id within a structure. */
const findNode = (structure: CompanyStructure, nodeId: string): RoleNode | undefined =>
  findRoleNode(structure, nodeId) ?? undefined;

/**
 * Start a recursive, real-work company run. Returns a handle the UI uses to
 * approve pending gates and to stop the run.
 */
export const runCompany = (input: RunCompanyInput): CompanyRunHandle => {
  const { companyId, companyName, structure, rules, goal, model, language, store } = input;

  let seq = 0;
  const now = (): number => Date.now();
  const newId = (prefix: string): string => `${prefix}-${++seq}-${now().toString(36)}`;
  const runId = newId('run');

  const abort = new AbortController();
  const approvalGate: IApprovalGate = createApprovalGate();
  const chat = createPlannerChat();

  store.reset();
  store.dispatch({ type: 'run-started', runId, rootId: structure.root.id, states: initialStates(structure) });

  // --- Soul/memory loader: compose the soul at runtime from the structure ---
  // (Requirement 1: workflow lives in the role's soul, derived from its
  // responsibilities + direct reports + rules — editable, no persistence.)
  const loadMind = async (nodeId: string, node: RoleNode): Promise<RoleMind> => {
    const soul = composeSoul({ companyName, node, directReports: directReportsOf(node), rules });
    return { soul, memory: '' };
  };

  // --- Briefing builder: company + role + rules + soul ----------------------
  const buildBriefing = (node: RoleNode, soul: string): string => {
    const lines = [`# Briefing for ${node.name}`, '', `Company: ${companyName}`];
    if (node.responsibilities) lines.push(`Responsibilities: ${node.responsibilities}`);
    if (rules.length > 0) lines.push('', 'Company rules:', ...rules.map((r) => `- ${r}`));
    if (soul) lines.push('', '## Your soul (workflow)', soul);
    return lines.join('\n');
  };

  // --- Real executor deps: resolve a conversation + drive a turn ------------
  // Concurrency is bounded renderer-side by a small semaphore (the heavy CLI
  // work itself runs in aioncore's own process, which the backend manages; the
  // renderer resource bridge does not expose leasing). This caps how many agent
  // turns we drive at once so a big company does not fan out unbounded. The
  // default scales with the host's core count instead of a fixed number, so a
  // small laptop runs fewer agents in parallel (less lag) and a workstation
  // runs more. An explicit config value still wins.
  const maxParallel = Math.max(1, input.config?.maxParallel ?? recommendedConcurrency({ min: 2, max: 6 }));
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (active < maxParallel) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        active += 1;
        resolve();
      });
    });
  };
  const release = (): void => {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  };

  const executorDeps: RoleExecutorDeps = {
    resolveConversation: async ({ nodeId }) => {
      const node = findNode(structure, nodeId);
      if (!node) return null;
      const convId = await openRoleChat({
        companyId,
        companyName,
        role: node,
        structure,
        rules,
        language,
        skipPrimer: true,
      });
      if (!convId) return null;
      // Resolve the workspace for the artifact path (best-effort).
      let workspace = '';
      try {
        const conv = await ipcBridge.conversation.get.invoke({ id: convId });
        workspace = (conv as { workspace?: string } | null)?.workspace ?? '';
      } catch {
        // Non-critical.
      }
      return { conversationId: convId, workspace };
    },
    sendMessage: ({ conversationId, content }) =>
      ipcBridge.conversation.sendMessage
        .invoke({ conversation_id: conversationId, input: content })
        .then((): void => undefined),
    onTurnCompleted: (listener) =>
      ipcBridge.conversation.turnCompleted.on((event) => {
        const content = typeof event.last_message?.content === 'string' ? event.last_message.content : '';
        // A turn is done for our purposes when the agent can accept input again
        // (status 'finished' → can_send_message true) or it reached a terminal state.
        const terminalState =
          event.state === 'ai_waiting_input' || event.state === 'stopped' || event.state === 'error';
        listener({
          conversationId: event.session_id,
          finished: event.can_send_message === true || terminalState,
          content,
        });
      }),
    // A semaphore-backed "lease" so the executor's lease/release hooks bound parallelism.
    requestLease: async () => {
      await acquire();
      return { id: newId('slot') };
    },
    releaseLease: () => release(),
    // Fallback when a role has no runnable executor: a short model-chat note.
    simulate: async ({ task }) =>
      chat({
        messages: [
          { role: 'user', content: `Briefly describe how you would do this task (no tools available): ${task}` },
        ],
      }),
  };

  const { runRole } = createRoleRunner({
    companyId,
    rules,
    model,
    loadMind,
    chat,
    buildBriefing,
    execute: ({ node, briefing, task, signal }) =>
      executeViaConversation(executorDeps, {
        nodeId: node.id,
        briefing,
        task,
        signal,
        timeoutMs: input.config?.executeTimeoutMs,
        estCostMB: input.config?.estCostMB,
      }),
    approvalGate,
    runTest: async ({ scenarioName, steps, fix, signal }) =>
      runTestGate(
        { run: (request) => testingClient.run(request) },
        {
          scenarioName,
          steps,
          maxRounds: input.config?.maxTestRounds,
          fix: ({ failureDetail }) => fix(failureDetail),
          signal,
        }
      ),
    emit: (event) => store.dispatch(event),
    runId,
    newId,
    now,
    config: input.config,
    signal: abort.signal,
  });

  const done = (async (): Promise<void> => {
    try {
      const result = await runRole({ node: structure.root, parentId: undefined }, goal, 0, new Set());
      if (abort.signal.aborted) {
        store.dispatch({ type: 'run-finished', runId, status: 'stopped', summary: '' });
      } else if (result.ok) {
        store.dispatch({ type: 'run-finished', runId, status: 'done', summary: result.result });
      } else {
        store.dispatch({
          type: 'run-error',
          runId,
          message: (result as { error?: string }).error ?? 'The run failed.',
        });
      }
    } catch (error) {
      store.dispatch({ type: 'run-error', runId, message: error instanceof Error ? error.message : String(error) });
    }
  })();

  return {
    runId,
    resolveApproval: (decision) => {
      approvalGate.resolve(decision);
    },
    stop: () => {
      abort.abort();
      approvalGate.cancelAll('stopped');
    },
    done,
  };
};

// Re-export for convenience.
export { loadCompanyRoleConversations, saveCompanyRoleConversation };
