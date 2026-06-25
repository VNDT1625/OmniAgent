/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Recursive role runner — the heart of the company pipeline (Requirement 2).
 *
 * A single generic function, `runRole`, models the essence of a real company:
 * **a superior talks only to its direct reports**. Each role:
 *   1. loads its soul (workflow) + memory + company rules,
 *   2. asks the planner what to do (delegate / execute / approve / test / finish),
 *   3. if it delegates, calls `runRole` recursively on its DIRECT children — so a
 *      child that has its own children delegates further (A→B→C/D, unbounded depth),
 *   4. gathers its children's results and synthesizes one result to report up.
 *
 * Guards keep it safe: a max recursion depth and a `visited` set (cycle
 * detection) prevent runaway recursion; a failed branch returns an error up to
 * its parent instead of crashing the whole run.
 *
 * All collaborators (planner, executor, gates, soul/memory loader, event sink)
 * are injected, so the recursion is unit-testable without a model or IPC.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import type { RoleNode } from '@process/company/companyOrchestrator';
import type { PlannerChat } from './delegationPlanner';
import { planRoleDecision } from './delegationPlanner';
import type { ExecuteOutcome } from './roleExecutor';
import type { IApprovalGate } from './approvalGate';
import type { TestGateOutcome } from './testGate';
import type { Artifact, PipelineEventSink, RoleResult, RunConfig } from './pipelineTypes';

/** A role plus its parent id, precomputed for the run. */
type RoleContext = {
  node: RoleNode;
  parentId?: string;
};

/** Soul + memory for one role. */
export type RoleMind = { soul: string; memory: string };

/** Injected collaborators for the runner. */
export type RoleRunnerDeps = {
  /** The company id (for ids/labels). */
  companyId: string;
  /** Company-wide rules folded into every plan. */
  rules: string[];
  /** Model id to run planning/synthesis with. */
  model?: string;
  /** Load a role's soul + memory (writeSoul/readMemory under the hood). */
  loadMind: (nodeId: string, node: RoleNode) => Promise<RoleMind>;
  /** The planner's model call. */
  chat: PlannerChat;
  /** Compose the briefing for a role's real execution (company+division+rules+soul). */
  buildBriefing: (node: RoleNode, soul: string) => string;
  /** Run a role's task for real (CLI/assistant in a workspace). */
  execute: (input: { node: RoleNode; briefing: string; task: string; signal?: AbortSignal }) => Promise<ExecuteOutcome>;
  /** Approval gate (boss authority). */
  approvalGate: IApprovalGate;
  /** Run a gated test. Optional; absent → a `request_test` decision is treated as execute. */
  runTest?: (input: {
    node: RoleNode;
    scenarioName: string;
    steps: string[];
    fix: (detail: string) => Promise<void>;
    signal?: AbortSignal;
  }) => Promise<TestGateOutcome>;
  /** Stream events to the store/UI. */
  emit: PipelineEventSink;
  /** Run id (for events). */
  runId: string;
  /** Unique id generator. */
  newId: (prefix: string) => string;
  /** Clock (Unix ms). */
  now: () => number;
  /** Tunables. */
  config?: RunConfig;
  /** Cancellation. */
  signal?: AbortSignal;
};

/** Truncate text for previews. */
const preview = (text: string, max = 160): string => (text.length <= max ? text : `${text.slice(0, max)}…`);

/**
 * Read the error from a failed result. The repo's tsconfig runs without
 * `strictNullChecks`, so TS does not narrow the `{ ok: false }` branch of a
 * discriminated union after an `ok` check; cast locally to read `error`.
 */
const errorOf = (result: { ok: boolean } & { error?: string }): string =>
  (result as { error?: string }).error ?? 'Unknown error.';

/** Default bounds. */
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_DELEGATIONS = 6;

/**
 * Create a runner bound to one run's collaborators. Returns `runRole`, which the
 * pipeline facade calls on the President with the top-level goal.
 */
export const createRoleRunner = (deps: RoleRunnerDeps) => {
  const maxDepth = deps.config?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxDelegations = deps.config?.maxDelegations ?? DEFAULT_MAX_DELEGATIONS;

  const emitStatus = (
    node: RoleNode,
    parentId: string | undefined,
    activity: string,
    extra: { talkingToId?: string; task?: string; conversationId?: string } = {}
  ): void => {
    deps.emit({
      type: 'role-status',
      runId: deps.runId,
      state: {
        nodeId: node.id,
        name: node.name,
        role: node.role,
        parentId,
        activity: activity as never,
        updatedAt: deps.now(),
        ...extra,
      },
    });
  };

  const emitMessage = (fromId: string, toId: string, content: string, kind: 'directive' | 'report' | 'note'): void => {
    deps.emit({
      type: 'message',
      runId: deps.runId,
      message: { id: deps.newId('msg'), fromId, toId, content, kind, at: deps.now() },
    });
  };

  const emitArtifact = (artifact: Artifact): void => {
    deps.emit({ type: 'artifact', runId: deps.runId, artifact });
  };

  /** Find a direct child node by id (only immediate children). */
  const directChildById = (node: RoleNode, childId: string): RoleNode | undefined =>
    node.children.find((c) => c.id === childId);

  /**
   * Run one role against an incoming task. `depth` and `visited` enforce the
   * recursion guards. Returns a {@link RoleResult} (never throws for operational
   * failures — those become `{ ok: false }` reported to the parent).
   */
  const runRole = async (
    ctx: RoleContext,
    incoming: string,
    depth: number,
    visited: Set<string>
  ): Promise<RoleResult> => {
    const { node, parentId } = ctx;

    if (deps.signal?.aborted) return { ok: false, error: 'Run cancelled.' };
    if (depth > maxDepth) return { ok: false, error: `Max delegation depth (${maxDepth}) exceeded at "${node.name}".` };
    if (visited.has(node.id)) return { ok: false, error: `Cycle detected at role "${node.id}".` };

    const nextVisited = new Set(visited);
    nextVisited.add(node.id);

    emitStatus(node, parentId, 'planning', { task: preview(incoming, 80) });

    const mind = await deps.loadMind(node.id, node).catch((): RoleMind => ({ soul: '', memory: '' }));
    const directChildren = node.children.slice(0, maxDelegations).map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      responsibilities: c.responsibilities,
    }));

    // A leaf with no children always executes (no one to delegate to).
    let decision = await planRoleDecision(
      {
        roleName: node.name,
        soul: mind.soul,
        memory: mind.memory,
        rules: deps.rules,
        incoming,
        directChildren,
        model: deps.model,
        signal: deps.signal,
      },
      deps.chat
    );

    const hasChildren = directChildren.length > 0;

    // Loop so a role can approve/test then continue, bounded by a small step cap.
    let result: RoleResult | undefined;
    let steps = 0;
    const MAX_STEPS = 4;
    let currentIncoming = incoming;

    /**
     * Enforce the binding administrative process by CODE, not just prompt: a role
     * that HAS direct reports is a manager — it MUST delegate and may not do the
     * hands-on work itself. If the planner (LLM) drifts and returns `execute` or a
     * bare `finish` for such a role, coerce it into a delegation that hands the
     * incoming task to EVERY direct report (one directive each), matched to their
     * responsibilities. This guarantees the company hierarchy is always honoured
     * regardless of what the model proposes.
     */
    const enforceDelegation = (proposed: typeof decision): typeof decision => {
      if (!hasChildren) return proposed;
      if (proposed.mode === 'execute' || proposed.mode === 'finish') {
        return {
          mode: 'delegate',
          directives: directChildren.map((c) => ({
            childId: c.id,
            task: c.responsibilities ? `${currentIncoming}\n\n(Your focus: ${c.responsibilities})` : currentIncoming,
          })),
        };
      }
      return proposed;
    };

    while (!result && steps < MAX_STEPS) {
      steps += 1;
      if (deps.signal?.aborted) return { ok: false, error: 'Run cancelled.' };

      // Binding hierarchy guard: a manager must delegate, never self-execute.
      decision = enforceDelegation(decision);

      switch (decision.mode) {
        case 'delegate': {
          emitStatus(node, parentId, 'delegating');

          // Dependency-aware scheduling (real pipeline): a directive runs only
          // after every directive it `dependsOn` has finished, and receives
          // those results as context. Directives with no deps start immediately,
          // so independent branches still run in parallel. A dependency cycle (or
          // a dep on an id not in this batch) is broken by ignoring the unmet dep
          // after the resolvable set is exhausted, so the run never hangs.
          const batch = decision.directives;
          const batchIds = new Set(batch.map((d) => d.childId));
          type ChildResult = { childName: string; childId: string; result: RoleResult };
          const done = new Map<string, ChildResult>();
          const running = new Map<string, Promise<ChildResult>>();

          const runDirective = async (
            directive: (typeof batch)[number],
            depResults: ChildResult[]
          ): Promise<ChildResult> => {
            const child = directChildById(node, directive.childId);
            if (!child)
              return {
                childName: directive.childId,
                childId: directive.childId,
                result: { ok: false, error: 'Unknown direct report.' },
              };
            // Fold finished dependencies' results into the task as context.
            const depContext =
              depResults.length > 0
                ? `${directive.task}\n\nContext from prerequisite work:\n${depResults
                    .map((d) => `- ${d.childName}: ${d.result.ok ? d.result.result : `[failed] ${errorOf(d.result)}`}`)
                    .join('\n')}`
                : directive.task;
            emitStatus(node, parentId, 'delegating', { talkingToId: child.id, task: preview(directive.task, 80) });
            emitMessage(node.id, child.id, depContext, 'directive');
            const childResult = await runRole({ node: child, parentId: node.id }, depContext, depth + 1, nextVisited);
            if (childResult.ok) emitMessage(child.id, node.id, childResult.result, 'report');
            else emitMessage(child.id, node.id, `[error] ${errorOf(childResult)}`, 'note');
            return { childName: child.name, childId: child.id, result: childResult };
          };

          // Schedule until every directive has finished. Each pass launches every
          // directive whose deps (that exist in this batch) are already done.
          while (done.size + running.size < batch.length) {
            let launchedThisPass = false;
            for (const directive of batch) {
              if (done.has(directive.childId) || running.has(directive.childId)) continue;
              const deps2 = (directive.dependsOn ?? []).filter((d) => batchIds.has(d));
              const unmet = deps2.filter((d) => !done.has(d));
              if (unmet.length === 0) {
                const depResults = deps2.map((d) => done.get(d)).filter((d): d is ChildResult => Boolean(d));
                running.set(directive.childId, runDirective(directive, depResults));
                launchedThisPass = true;
              }
            }

            if (running.size === 0 && !launchedThisPass) {
              // Nothing runnable and nothing in flight → a dependency cycle or an
              // unresolvable dep among the remaining directives. Launch the rest
              // ignoring deps so the run completes instead of hanging.
              for (const directive of batch) {
                if (!done.has(directive.childId) && !running.has(directive.childId)) {
                  running.set(directive.childId, runDirective(directive, []));
                }
              }
            }

            // Wait for the next directive to finish, then loop to launch newly-unblocked ones.
            if (running.size > 0) {
              const settled = await Promise.race(Array.from(running.values()));
              done.set(settled.childId, settled);
              running.delete(settled.childId);
            }
          }

          // Preserve the directive order for the synthesis report.
          const childResults = batch.map((d) => done.get(d.childId)).filter((c): c is ChildResult => Boolean(c));

          // Synthesize: ask the model to combine the children's reports.
          emitStatus(node, parentId, 'summarizing');
          const reportBlock = childResults
            .map((c) => `- ${c.childName}: ${c.result.ok ? c.result.result : `[failed] ${errorOf(c.result)}`}`)
            .join('\n');
          const synthesis = await deps
            .chat({
              model: deps.model,
              signal: deps.signal,
              messages: [
                {
                  role: 'system',
                  content: `You are "${node.name}". Synthesize your team's reports into one concise result for your superior.`,
                },
                {
                  role: 'user',
                  content: `Original task: ${currentIncoming}\n\nTeam reports:\n${reportBlock}\n\nWrite the combined result (3-6 sentences).`,
                },
              ],
            })
            .catch(() => reportBlock);
          const artifactIds = childResults.flatMap((c) => (c.result.ok ? c.result.artifactIds : []));
          result = { ok: true, result: synthesis, artifactIds };
          break;
        }

        case 'execute': {
          emitStatus(node, parentId, 'executing', { task: preview(decision.task || currentIncoming, 80) });
          const briefing = deps.buildBriefing(node, mind.soul);
          deps.emit({ type: 'execute-started', runId: deps.runId, nodeId: node.id, conversationId: '', workspace: '' });
          const outcome = await deps.execute({
            node,
            briefing,
            task: decision.task || currentIncoming,
            signal: deps.signal,
          });
          if (outcome.ok) {
            const artifact: Artifact = {
              id: deps.newId('art'),
              nodeId: node.id,
              kind: outcome.simulated ? 'note' : 'code-change',
              title: `${node.name} output`,
              path: outcome.workspace || undefined,
              preview: preview(outcome.result, 400),
              simulated: outcome.simulated,
              at: deps.now(),
            };
            emitArtifact(artifact);
            deps.emit({
              type: 'execute-finished',
              runId: deps.runId,
              nodeId: node.id,
              ok: true,
              resultPreview: preview(outcome.result),
              artifactId: artifact.id,
            });
            result = { ok: true, result: outcome.result, artifactIds: [artifact.id] };
          } else {
            deps.emit({
              type: 'execute-finished',
              runId: deps.runId,
              nodeId: node.id,
              ok: false,
              resultPreview: errorOf(outcome),
            });
            result = { ok: false, error: errorOf(outcome) };
          }
          break;
        }

        case 'request_approval': {
          emitStatus(node, parentId, 'awaiting-approval', { task: preview(decision.summary, 80) });
          const requestId = deps.newId('appr');
          const artifact: Artifact = {
            id: deps.newId('art'),
            nodeId: node.id,
            kind: 'doc',
            title: decision.summary,
            preview: preview(decision.artifact, 400),
            at: deps.now(),
          };
          emitArtifact(artifact);
          deps.emit({
            type: 'approval',
            runId: deps.runId,
            request: {
              id: requestId,
              fromId: node.id,
              gate: 'approval',
              summary: decision.summary,
              artifactPreview: preview(decision.artifact, 400),
              at: deps.now(),
            },
          });
          const verdict = await deps.approvalGate.request(requestId);
          deps.emit({ type: 'approval-resolved', runId: deps.runId, decision: verdict });
          if (verdict.approved) {
            // Proceed: the approved artifact becomes the role's result.
            result = { ok: true, result: decision.artifact, artifactIds: [artifact.id] };
          } else {
            // Rejected: re-plan with the reviewer's note folded into the task.
            currentIncoming = `${incoming}\n\n[Revision requested] ${verdict.note ?? 'Please revise.'}`;
            decision = await planRoleDecision(
              {
                roleName: node.name,
                soul: mind.soul,
                memory: mind.memory,
                rules: deps.rules,
                incoming: currentIncoming,
                directChildren,
                model: deps.model,
                signal: deps.signal,
              },
              deps.chat
            );
          }
          break;
        }

        case 'request_test': {
          if (!deps.runTest) {
            // No tester wired → fall back to executing the task.
            decision = { mode: 'execute', task: currentIncoming };
            break;
          }
          emitStatus(node, parentId, 'testing', { task: preview(decision.scenarioName, 80) });
          deps.emit({ type: 'test-started', runId: deps.runId, nodeId: node.id, scenarioName: decision.scenarioName });
          const briefing = deps.buildBriefing(node, mind.soul);
          const testOutcome = await deps.runTest({
            node,
            scenarioName: decision.scenarioName,
            steps: decision.steps,
            fix: async (detail) => {
              await deps.execute({
                node,
                briefing,
                task: `A test failed: ${detail}. Fix the issue, then it will be re-tested.`,
                signal: deps.signal,
              });
            },
            signal: deps.signal,
          });
          deps.emit({
            type: 'test-finished',
            runId: deps.runId,
            nodeId: node.id,
            passed: testOutcome.passed,
            reportPath: testOutcome.reportPath,
          });
          if (testOutcome.reportPath) {
            emitArtifact({
              id: deps.newId('art'),
              nodeId: node.id,
              kind: 'test-report',
              title: `Test: ${decision.scenarioName}`,
              path: testOutcome.reportPath,
              at: deps.now(),
            });
          }
          result = testOutcome.passed
            ? {
                ok: true,
                result: `Tests passed for "${decision.scenarioName}" after ${testOutcome.rounds} round(s).`,
                artifactIds: [],
              }
            : { ok: false, error: `Tests failed for "${decision.scenarioName}" after ${testOutcome.rounds} round(s).` };
          break;
        }

        case 'request_permission': {
          emitStatus(node, parentId, 'awaiting-approval', { task: preview(decision.action, 80) });
          const requestId = deps.newId('perm');
          deps.emit({
            type: 'approval',
            runId: deps.runId,
            request: { id: requestId, fromId: node.id, gate: 'permission', summary: decision.action, at: deps.now() },
          });
          const verdict = await deps.approvalGate.request(requestId);
          deps.emit({ type: 'approval-resolved', runId: deps.runId, decision: verdict });
          // After a permission decision, execute (with the verdict folded in).
          currentIncoming = verdict.approved
            ? `${incoming}\n\n[Permission granted${verdict.note ? `: ${verdict.note}` : ''}] Proceed.`
            : `${incoming}\n\n[Permission denied${verdict.note ? `: ${verdict.note}` : ''}] Proceed without it or escalate.`;
          decision = { mode: 'execute', task: currentIncoming };
          break;
        }

        case 'finish':
        default: {
          result = { ok: true, result: decision.result, artifactIds: [] };
          break;
        }
      }
    }

    const final = result ?? { ok: true, result: 'Completed.', artifactIds: [] };
    emitStatus(node, parentId, final.ok ? 'done' : 'failed');
    return final;
  };

  return { runRole };
};
