/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the Agent Company **execution pipeline** (the recursive,
 * real-work engine — see `.kiro/specs/agent-company-pipeline/design.md`).
 *
 * This is the renderer-side orchestrator's vocabulary: the events streamed to
 * the Manager popup, the per-role run state for the recursive tree board, the
 * artifacts produced (docs / reports / code changes / test reports), and the
 * planner's decision shape. Everything here is plain data so the engine stays
 * unit-testable with all I/O injected.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import type { RoleNode } from '@process/company/companyOrchestrator';

/** A role's role-kind, re-exported for convenience. */
export type RoleKind = RoleNode['role'];

/** What a role is doing right now — drives the recursive tree board. */
export type RoleActivity =
  | 'idle'
  | 'planning'
  | 'delegating'
  | 'executing'
  | 'awaiting-approval'
  | 'testing'
  | 'summarizing'
  | 'done'
  | 'failed';

/** Live status of one role in the running company tree. */
export type RoleRunState = {
  /** Role node id. */
  nodeId: string;
  /** Display name. */
  name: string;
  /** Role kind. */
  role: RoleKind;
  /** Parent role node id (undefined for the President). */
  parentId?: string;
  /** Current activity. */
  activity: RoleActivity;
  /** Id of the role this one is talking to right now (delegating to / reporting to). */
  talkingToId?: string;
  /** Short label of the current task/topic. */
  task?: string;
  /** Conversation id backing this role's real execution (when executing). */
  conversationId?: string;
  /** Last update time (Unix ms). */
  updatedAt: number;
};

/** Kind of artifact a role can produce. */
export type ArtifactKind = 'doc' | 'report' | 'test-report' | 'code-change' | 'note';

/** A tangible output of the run, surfaced in the Manager popup. */
export type Artifact = {
  /** Stable id. */
  id: string;
  /** Role that produced it. */
  nodeId: string;
  /** Kind of artifact. */
  kind: ArtifactKind;
  /** Human title. */
  title: string;
  /** Absolute path on disk when the artifact is a real file (openable in the editor). */
  path?: string;
  /** Short text preview (for docs/reports without a file). */
  preview?: string;
  /** `true` when produced by the model-chat fallback (no real executor) — not real work. */
  simulated?: boolean;
  /** Produced-at time (Unix ms). */
  at: number;
};

/** One chat line in the recursive transcript. */
export type PipelineMessage = {
  /** Stable id. */
  id: string;
  /** Speaker role node id. */
  fromId: string;
  /** Addressee role node id. */
  toId: string;
  /** Body. */
  content: string;
  /** `directive` = down the tree, `report` = up the tree, `note` = system. */
  kind: 'directive' | 'report' | 'note';
  /** Produced-at time (Unix ms). */
  at: number;
};

/** A pending permission/approval request the boss (or user) must answer. */
export type PendingApproval = {
  /** Stable request id. */
  id: string;
  /** Requester role node id. */
  fromId: string;
  /** What kind of gate: a stage-approval (artifact) or a sensitive-action permission. */
  gate: 'approval' | 'permission';
  /** Short summary of what is being approved. */
  summary: string;
  /** Optional artifact preview tied to an approval gate. */
  artifactPreview?: string;
  /** Requested-at time (Unix ms). */
  at: number;
};

/** The boss/user decision on a {@link PendingApproval}. */
export type ApprovalDecision = {
  /** The request being answered. */
  requestId: string;
  /** Whether it was approved. */
  approved: boolean;
  /** Optional note (fed back to the requester on rejection). */
  note?: string;
};

/** A single directive from a role to one of its direct children. */
export type Directive = {
  /** Direct-child role node id (must be an immediate child — no skipping levels). */
  childId: string;
  /** The task for that child. */
  task: string;
  /**
   * Ids of OTHER direct children (their `childId`s) whose results this directive
   * depends on. The runner waits for those to finish first and feeds their
   * results into this child's task as context. Empty/absent = no dependency, so
   * the directive can start immediately (and run in parallel with other
   * dependency-free ones). Enables real pipelines, e.g. Backend/Frontend depend
   * on Architecture; QA depends on Backend + Frontend.
   */
  dependsOn?: string[];
};

/** What the planner decided a role should do this step. */
export type PlannerDecision =
  | { mode: 'delegate'; directives: Directive[] }
  | { mode: 'execute'; task: string }
  | { mode: 'request_approval'; artifact: string; summary: string }
  | { mode: 'request_test'; scenarioName: string; steps: string[] }
  | { mode: 'request_permission'; action: string; reason?: string }
  | { mode: 'finish'; result: string };

/** Result of running one role (success carries its synthesized result + artifacts). */
export type RoleResult = { ok: true; result: string; artifactIds: string[] } | { ok: false; error: string };

/** Tunable bounds + costs for one company run. */
export type RunConfig = {
  /** Max recursion depth (President = 0). Default 6. */
  maxDepth?: number;
  /** Max direct children a role delegates to per run. Default 6. */
  maxDelegations?: number;
  /** Max test retry rounds before reporting failure up. Default 3. */
  maxTestRounds?: number;
  /** Timeout (ms) for one real execution turn before it is cancelled. Default 600000. */
  executeTimeoutMs?: number;
  /** Estimated RAM (MB) charged per agent turn. Default 384. */
  estCostMB?: number;
  /** Max concurrent real-execution turns driven at once. Default 3. */
  maxParallel?: number;
};

/** A streamed pipeline event (engine → store → Manager popup). */
export type PipelineEvent =
  | { type: 'run-started'; runId: string; rootId: string; states: RoleRunState[] }
  | { type: 'role-status'; runId: string; state: RoleRunState }
  | { type: 'message'; runId: string; message: PipelineMessage }
  | { type: 'execute-started'; runId: string; nodeId: string; conversationId: string; workspace: string }
  | { type: 'execute-finished'; runId: string; nodeId: string; ok: boolean; resultPreview: string; artifactId?: string }
  | { type: 'approval'; runId: string; request: PendingApproval }
  | { type: 'approval-resolved'; runId: string; decision: ApprovalDecision }
  | { type: 'test-started'; runId: string; nodeId: string; scenarioName: string }
  | { type: 'test-finished'; runId: string; nodeId: string; passed: boolean; reportPath?: string }
  | { type: 'artifact'; runId: string; artifact: Artifact }
  | { type: 'run-finished'; runId: string; status: 'done' | 'stopped' | 'error'; summary: string }
  | { type: 'run-error'; runId: string; message: string };

/** Sink the engine pushes {@link PipelineEvent}s through. */
export type PipelineEventSink = (event: PipelineEvent) => void;

/** Lifecycle phase of a pipeline run (for the hook/UI). */
export type PipelinePhase = 'idle' | 'running' | 'finished' | 'stopped' | 'error';
