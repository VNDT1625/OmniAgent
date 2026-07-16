/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Elastic, multi-tier orchestration for the agent-company model (Requirement 3,
 * criteria 3.1, 3.2 and 3.12).
 *
 * ## Role mapping (criterion 3.2)
 *
 * The company organises agents into a role tree that scales with project size:
 *
 * ```
 *   President            (receives the goal, represents the company to the user)
 *     └─ Division head    (per "mảng": Frontend, Backend, ...)
 *          └─ Worker      ("tay chân" — executes a concrete task, then exits)
 * ```
 *
 * Onto the existing Team Mode (Leader ↔ Teammate, see `teams` / `mailbox` /
 * `team_tasks` and the `ipcBridge.team.*` → `/api/teams/*` surface) this maps as:
 *
 * - **President ≈ Team Leader** (`TeammateRole = 'leader'`).
 * - **Division head ≈ Teammate** in a managing role.
 * - **Worker ≈ Teammate** in an executing role.
 *
 * ## ⚠️ FLATTEN simulation (the one architectural compromise)
 *
 * Team Mode is **only 2-level** today — `TeammateRole` is literally
 * `'leader' | 'teammate'` (`common/types/team/teamTypes.ts`), and the team API
 * exposes a single Leader plus a flat pool of Teammates. There is no native
 * notion of a Teammate that itself manages other Teammates.
 *
 * This orchestrator therefore keeps the **role tree** (arbitrarily deep) in the
 * Main process, but **spawns every executing agent FLAT** as a Team Mode
 * Teammate under one Leader. The managerial layers (division heads) are
 * *simulated*: instead of spawning a live head agent that re-delegates, the head's
 * division context is composed into each worker's briefing via
 * {@link ContextLayering.buildDelegationContext}. Every place that performs this
 * flattening is marked with an `// FLATTEN:` comment so it can be upgraded to
 * real nesting if/when aioncore grows a multi-level team API (see the "CẦN
 * BACKEND" note in `design.md`, Yêu cầu 3).
 *
 * ## Concurrency (criterion 3.12)
 *
 * The number of agents running in parallel is **not** decided here — it is
 * governed by the {@link IResourceCoordinator}. Before spawning each agent the
 * orchestrator awaits `requestLease({ kind: 'agent', estCostMB })`; that call
 * blocks (queues) until the coordinator's budget has room, so parallelism is a
 * pure function of free RAM. The lease is released when the agent finishes. A
 * hardcoded fallback limiter is used **only** when no coordinator is injected
 * (see {@link FALLBACK_MAX_PARALLEL_AGENTS}); production wiring always passes the
 * real coordinator.
 *
 * ## Testability
 *
 * Every heavy collaborator is injected (see {@link CompanyOrchestratorDeps}) so
 * the orchestrator can be unit-tested without aioncore, a live CLI, or disk:
 * the memory store, the context-layering service, the call-template manager, the
 * resource coordinator, and the {@link TeamGateway} that abstracts the team RPC.
 *
 * Process boundary: Main-process (Node.js) service. No DOM APIs.
 */

import type { AssembledCall, ICallTemplateManager } from './callTemplate';
import type { ContextLayering, MailboxMessage } from './contextLayering';
import type { IMemoryStore } from './memoryStore';
import type { IResourceCoordinator } from '@process/resource/resourceCoordinator';
import type { TaskKind } from '@process/resource/leaseTypes';

/** {@link TaskKind} used for every agent spawned by the company orchestrator. */
const AGENT_TASK_KIND: TaskKind = 'agent';

/** Default estimated RAM (MB) charged against the budget per spawned agent. */
const DEFAULT_AGENT_EST_COST_MB = 512;

/**
 * Hardcoded parallelism cap used **only** when no {@link IResourceCoordinator}
 * is injected (see the concurrency note in the module doc). When the coordinator
 * is wired — the normal case — this constant is never consulted; the coordinator
 * decides parallelism from free RAM (criterion 3.12). TODO(lease): remove once
 * every call site is guaranteed to pass a coordinator.
 */
const FALLBACK_MAX_PARALLEL_AGENTS = 2;

/** Max characters of a worker result recorded into the division head's memory. */
const MEMORY_RESULT_PREVIEW_CHARS = 500;

// ---------------------------------------------------------------------------
// Role tree (the elastic company structure)
// ---------------------------------------------------------------------------

/**
 * A role in the company hierarchy (criterion 3.2).
 * - `'president'`     — the single root; receives the goal, faces the user.
 * - `'division-head'` — owns a division ("mảng") and its context.
 * - `'worker'`        — an ephemeral executor ("tay chân").
 */
export type CompanyRole = 'president' | 'division-head' | 'worker';

/**
 * Which concrete executor backs a role (the user's two sources, plus drafts):
 * - `'cli'`       — an installed CLI engine (claude/codex/gemini/…).
 * - `'assistant'` — an existing AionUi assistant (carries its own rules + model).
 * - `'draft'`     — an assistant the generator proposed but that does not exist
 *   yet; the user accepts a batch of drafts to turn them into real assistants.
 */
export type RoleAssignmentKind = 'cli' | 'assistant' | 'draft';

/**
 * The executor assigned to a role. For `cli`/`assistant`, {@link refId} points
 * at the installed CLI agent id (or `agent_type`) / the assistant id. For
 * `draft`, {@link refId} is a temporary slug and {@link draft} carries the
 * proposed assistant so the UI can show it and the bridge can create it on
 * accept. `model` is the provider model to run it with (optional — the CLI /
 * assistant default is used when absent).
 */
export type RoleAssignment = {
  /** Source of the executor. */
  kind: RoleAssignmentKind;
  /** CLI agent id / assistant id / draft slug, depending on {@link kind}. */
  refId: string;
  /** Display label (CLI name / assistant name). */
  label: string;
  /** Provider model id to run this role with (optional). */
  model?: string;
  /** Present only when `kind === 'draft'`: the proposed assistant to create. */
  draft?: RoleAssignmentDraft;
  /**
   * Capabilities granted to this role so its agent can actually do its job
   * (Requirement 9): which MCP servers it may use, which skills are enabled, and
   * the permission / "super" session mode it runs in. Without these a role often
   * cannot perform its task (e.g. browse the web, edit Office files, run
   * sensitive commands). Optional — absent means "executor defaults only".
   */
  capabilities?: RoleCapabilities;
};

/**
 * The capabilities granted to a role (Requirement 9). These map directly onto a
 * conversation's `extra` fields when the role's chat is created: MCP servers
 * (`selected_mcp_server_ids` / `selected_session_mcp_servers`), skills
 * (`preset_enabled_skills`), and the permission/super session mode
 * (`session_mode`).
 */
export type RoleCapabilities = {
  /** Ids of MCP servers (user + built-in) this role may use. */
  mcpServerIds?: string[];
  /** Skill names enabled for this role. */
  skills?: string[];
  /** Session/permission mode (e.g. `bypassPermissions`, `yolo`, `full-access`). */
  sessionMode?: string;
};

/** A proposed (not-yet-created) assistant for a role with no existing match. */
export type RoleAssignmentDraft = {
  /** Proposed assistant name. */
  name: string;
  /** Base engine the assistant runs on (`preset_agent_type`, e.g. `claude`). */
  presetAgentType: string;
  /** Proposed model id from a provider. */
  model?: string;
  /** Proposed rule/instructions markdown ("soul" of the assistant). */
  rules?: string;
  /** Proposed skills to enable. */
  skills?: string[];
};

/**
 * A node in the company role tree. The tree may be arbitrarily deep in this
 * model; the {@link CompanyOrchestrator} flattens it onto Team Mode at spawn
 * time (see the FLATTEN note in the module doc).
 */
export type RoleNode = {
  /** Stable agent id within the company (used as the memory / template key). */
  id: string;
  /** This node's role in the hierarchy. */
  role: CompanyRole;
  /** Human-readable name (e.g. `'President'`, `'Frontend Lead'`). */
  name: string;
  /**
   * Division ("mảng") this node belongs to. Required for `division-head` and
   * `worker` nodes; the value must match a division registered in the injected
   * {@link ContextLayering} so its context can be attached on delegation.
   */
  divisionId?: string;
  /**
   * Short human-readable description of what this role is responsible for, shown
   * in the UI so the hierarchy reads clearly. Designed by the role-chart
   * generator (criterion 3.11); optional for legacy/empty configs.
   */
  responsibilities?: string;
  /** Team-backend agent type hint (e.g. `'claude'`, `'codex'`). Optional. */
  agentType?: string;
  /** Model hint passed through to the team backend. Optional. */
  model?: string;
  /**
   * The executor assigned to this role (CLI / assistant / draft) plus its model.
   * Attached from the persisted config so the UI can show "Role → Claude Code"
   * or "Role → Assistant X (model Y)". Optional for legacy/empty configs.
   */
  assignment?: RoleAssignment;
  /** Estimated RAM (MB) this agent consumes; overrides the request/global default. */
  estCostMB?: number;
  /** Child roles managed by this node. Empty for leaf workers. */
  children: RoleNode[];
};

/** A fully-built, elastic company structure rooted at the President. */
export type CompanyStructure = {
  /** Company this structure belongs to. */
  companyId: string;
  /** Root of the role tree — always a `president` node. */
  root: RoleNode;
  /**
   * Id of the model that powers every agent in this company (all CLI agents run
   * through the user's configured provider/model). Attached by the bridge layer
   * for display; `createStructure` itself leaves it unset.
   */
  poweredByModel?: string;
};

/** Specification of a single division ("mảng") for {@link createStructure}. */
export type DivisionSpec = {
  /** Stable division id; must match a division registered in {@link ContextLayering}. */
  divisionId: string;
  /** Human-readable division name. */
  name: string;
  /** Optional explicit division-head name; defaults to `"<name> Lead"`. */
  headName?: string;
  /** How many worker agents this division can run (its capacity). */
  workerCount: number;
  /** Optional short description of what this division is responsible for. */
  responsibilities?: string;
  /** Optional executor assigned to this division's head (CLI / assistant / draft). */
  assignment?: RoleAssignment;
};

/**
 * Input describing the company to build. Elasticity (criteria 3.1 / 3.2) is
 * expressed here: an empty `divisions` list yields a *small* company (President
 * managing a flat pool of workers directly); a non-empty list yields the *full*
 * hierarchy (President → division heads → workers).
 */
export type CompanyStructureSpec = {
  /** Company id; also used to derive node ids. */
  companyId: string;
  /** Optional President display name. Defaults to `'President'`. */
  presidentName?: string;
  /** Optional executor assigned to the President (CLI / assistant / draft). */
  presidentAssignment?: RoleAssignment;
  /**
   * Per-worker executor assignments, keyed by worker node id
   * (`<companyId>:worker:<divisionId>:<index>`). Workers are generated from
   * `workerCount`, so their assignments live in this side map rather than on the
   * division. Optional; absent workers inherit their head's/company's executor.
   */
  workerAssignments?: Record<string, RoleAssignment>;
  /**
   * Divisions of the company. **Empty = small task**: the President manages
   * {@link CompanyStructureSpec.directWorkerCount} workers directly with no
   * division-head layer. **Non-empty = large task**: full hierarchy.
   */
  divisions: DivisionSpec[];
  /**
   * For the small-task case (no divisions), how many workers the President
   * manages directly. Defaults to 2. Ignored when `divisions` is non-empty.
   */
  directWorkerCount?: number;
  /**
   * Division id assigned to the President's direct workers in the small-task
   * case; must be registered in {@link ContextLayering}. Defaults to `'general'`.
   */
  directDivisionId?: string;
  /**
   * Company-wide rules every agent must follow (criterion 3.10). Optional; when
   * present (e.g. designed by `createFromDescription`), the bridge persists them
   * into the company config so they ride along with every delegation.
   */
  rules?: string[];
};

// ---------------------------------------------------------------------------
// Team gateway (abstraction over the Team Mode RPC surface)
// ---------------------------------------------------------------------------

/**
 * Abstraction over the Team Mode backend so the orchestrator stays decoupled
 * from the concrete `ipcBridge.team.*` (`/api/teams/*`) transport and is
 * unit-testable without aioncore.
 *
 * Mapping to the **real, located** team API (`common/adapter/ipcBridge.ts`,
 * `common/adapter/teamMapper.ts`):
 *
 * - {@link createTeam}    → `team.create` (`POST /api/teams`) with the President
 *   as the `'lead'` agent, followed by `team.ensureSession`
 *   (`POST /api/teams/:id/session`).
 * - {@link spawnTeammate} → `team.addAgent` (`POST /api/teams/:id/agents`) with a
 *   `'teammate'` agent. **FLATTEN:** both division heads and workers map to this
 *   same flat call.
 * - {@link stopTeammate}  → `team.removeAgent` (`DELETE /api/teams/:id/agents/:slot`).
 *
 * ⚠️ Assumption — no 1:1 REST was located for "deliver a briefing to a teammate"
 * or "await a teammate's task result". {@link sendMessage} is expected to be
 * backed by the Team Mode **mailbox** (the `mailbox` table referenced by
 * `contextLayering.ts`), and {@link awaitResult} by correlating the
 * `team.teammate.message` / `team.agent.status` WS events
 * (`ITeamTeammateMessageEvent` / `ITeamAgentStatusEvent`). Those wirings live in
 * the bridge layer (Task 4.9); this orchestrator depends only on the interface.
 */
export type TeamGateway = {
  /** Create (or reuse) the underlying team and return a handle to it. */
  createTeam(params: CreateTeamParams): Promise<TeamHandle>;
  /** Spawn one flat Teammate for a role node and return its assigned slot. */
  spawnTeammate(params: SpawnTeammateParams): Promise<SpawnedTeammate>;
  /** Deliver a composed briefing (mailbox message) to a spawned teammate. */
  sendMessage(params: SendMessageParams): Promise<void>;
  /** Resolve with the teammate's final result when its task completes. */
  awaitResult(params: AwaitResultParams): Promise<string>;
  /**
   * Tear down an ephemeral teammate once it has finished (criterion 3.3 —
   * "làm xong rồi tắt"). Optional: omit if the backend reaps agents itself.
   */
  stopTeammate?(params: StopTeammateParams): Promise<void>;
};

/** Parameters for {@link TeamGateway.createTeam}. */
export type CreateTeamParams = {
  /** Company the team backs. */
  companyId: string;
  /** Display name for the team. */
  name: string;
  /** The President role node, mapped to the Team Leader. */
  president: RoleNode;
};

/** Handle to a created/looked-up team. */
export type TeamHandle = {
  /** Backend team id (`TTeam.id`). */
  teamId: string;
  /** Slot id of the President/Leader agent (`TeamAgent.slot_id`). */
  leaderSlotId: string;
};

/** Parameters for {@link TeamGateway.spawnTeammate}. */
export type SpawnTeammateParams = {
  /** Team to spawn into. */
  teamId: string;
  /**
   * Role node being spawned. **FLATTEN:** division-head and worker nodes are
   * both spawned as flat `'teammate'` agents; the gateway may use `node.role`
   * only for naming/labelling, not for backend nesting.
   */
  node: RoleNode;
  /** CLI invocation assembled from the locked call template (command/args/env). */
  call: AssembledCall;
};

/** Result of {@link TeamGateway.spawnTeammate}. */
export type SpawnedTeammate = {
  /** Backend slot id of the spawned teammate (`TeamAgent.slot_id`). */
  slotId: string;
};

/** Parameters for {@link TeamGateway.sendMessage}. */
export type SendMessageParams = {
  /** Team the recipient belongs to. */
  teamId: string;
  /** Slot id of the recipient teammate. */
  toSlotId: string;
  /** The composed briefing carried over the mailbox. */
  message: MailboxMessage;
};

/** Parameters for {@link TeamGateway.awaitResult}. */
export type AwaitResultParams = {
  /** Team the teammate belongs to. */
  teamId: string;
  /** Slot id of the teammate whose result to await. */
  slotId: string;
};

/** Parameters for {@link TeamGateway.stopTeammate}. */
export type StopTeammateParams = {
  /** Team the teammate belongs to. */
  teamId: string;
  /** Slot id of the teammate to stop. */
  slotId: string;
};

// ---------------------------------------------------------------------------
// Delegation request / outcome
// ---------------------------------------------------------------------------

/** Input describing one round of downward delegation from the President. */
export type DelegationRequestInput = {
  /**
   * The overall goal the President received and represents to the user
   * (criterion 3.2). Used as each worker's prompt unless a division-specific
   * task is supplied in {@link DelegationRequestInput.taskByDivision}.
   */
  goal: string;
  /**
   * Optional per-division task override. Workers in a division listed here run
   * its task; workers in any other division fall back to `goal`.
   */
  taskByDivision?: Record<string, string>;
  /**
   * Estimated RAM (MB) charged against the coordinator budget per spawned
   * agent. Overridden per-node by {@link RoleNode.estCostMB}; defaults to
   * {@link DEFAULT_AGENT_EST_COST_MB}.
   */
  estCostMBPerAgent?: number;
};

/** The outcome of delegating to a single worker. */
export type WorkerOutcome = {
  /** Division the worker belonged to. */
  divisionId: string;
  /** Role-node id of the worker. */
  nodeId: string;
  /** Backend slot id the worker was spawned into. */
  slotId: string;
  /** The prompt the worker executed. */
  prompt: string;
  /** The worker's final result. */
  result: string;
};

/** Aggregate result of a {@link CompanyOrchestrator.delegate} call. */
export type DelegationOutcome = {
  /** Company the delegation ran for. */
  companyId: string;
  /** Team the agents were spawned into. */
  teamId: string;
  /** One entry per worker that executed, in completion order. */
  outcomes: WorkerOutcome[];
};

// ---------------------------------------------------------------------------
// Orchestrator surface + dependencies
// ---------------------------------------------------------------------------

/** Injectable collaborators for {@link createCompanyOrchestrator}. */
export type CompanyOrchestratorDeps = {
  /** Layered context (company + per-division) used to brief workers. */
  contextLayering: ContextLayering;
  /** Persistent per-agent memory; division-head memory records delegation outcomes. */
  memoryStore: IMemoryStore;
  /** Self-recovering CLI call template; resolves how each worker is invoked. */
  callTemplateManager: ICallTemplateManager;
  /** Abstraction over the Team Mode RPC surface. */
  teamGateway: TeamGateway;
  /**
   * Resource coordinator gating parallelism (criterion 3.12). Optional: when
   * omitted, a hardcoded {@link FALLBACK_MAX_PARALLEL_AGENTS} limiter is used and
   * the wiring is marked TODO(lease). Production always passes the real one.
   */
  resourceCoordinator?: IResourceCoordinator;
};

/** Public contract of the company orchestrator. */
export type CompanyOrchestrator = {
  /**
   * Build an elastic company structure from a spec (criteria 3.1 / 3.2). Pure:
   * no side effects, no spawning — it only models the role tree.
   */
  createStructure(spec: CompanyStructureSpec): CompanyStructure;
  /**
   * Walk the structure's worker leaves, attach each one's division context,
   * spawn agents FLAT through the {@link TeamGateway}, and gather their results.
   * Parallelism is gated by the resource coordinator (criterion 3.12).
   */
  delegate(structure: CompanyStructure, request: DelegationRequestInput): Promise<DelegationOutcome>;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** A held permission to run one agent; `release` frees it (idempotent). */
type AgentSlotLease = { release: () => void };

/**
 * A tiny FIFO semaphore used only as the fallback parallelism gate when no
 * resource coordinator is injected. `acquire` resolves with a release function
 * once a slot is free.
 */
const createSemaphore = (limit: number): { acquire: () => Promise<() => void> } => {
  let available = Math.max(1, limit);
  const waiters: Array<() => void> = [];

  const release = (): void => {
    available += 1;
    const next = waiters.shift();
    if (next) {
      available -= 1;
      next();
    }
  };

  const acquire = (): Promise<() => void> => {
    if (available > 0) {
      available -= 1;
      return Promise.resolve(release);
    }
    return new Promise<() => void>((resolve) => {
      waiters.push(() => resolve(release));
    });
  };

  return { acquire };
};

/** Depth-first collect every `worker`-role leaf reachable from `node`. */
const collectWorkers = (node: RoleNode): RoleNode[] => {
  if (node.role === 'worker') return [node];
  return node.children.flatMap(collectWorkers);
};

/** Template key for an agent: `<companyId>/agents/<nodeId>` (matches the file store layout). */
const templateKeyFor = (companyId: string, nodeId: string): string => `${companyId}/agents/${nodeId}`;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a {@link CompanyOrchestrator} backed by the injected collaborators.
 *
 * @param deps All heavy collaborators (see {@link CompanyOrchestratorDeps}).
 * @returns An orchestrator that builds structures and delegates work.
 */
export const createCompanyOrchestrator = (deps: CompanyOrchestratorDeps): CompanyOrchestrator => {
  const { contextLayering, memoryStore, callTemplateManager, teamGateway, resourceCoordinator } = deps;

  /** Cached team handle per company, so repeated delegations reuse one team. */
  const teamByCompany = new Map<string, TeamHandle>();
  /** Fallback limiter, instantiated lazily only when no coordinator is present. */
  const fallbackSemaphore = resourceCoordinator ? undefined : createSemaphore(FALLBACK_MAX_PARALLEL_AGENTS);

  const createStructure = (spec: CompanyStructureSpec): CompanyStructure => {
    const presidentName = spec.presidentName ?? 'President';
    const president: RoleNode = {
      id: `${spec.companyId}:president`,
      role: 'president',
      name: presidentName,
      ...(spec.presidentAssignment ? { assignment: spec.presidentAssignment } : {}),
      children: [],
    };

    if (spec.divisions.length === 0) {
      // ── Small task (criterion 3.1): no division-head layer. The President
      //    manages a flat pool of workers directly. FLATTEN is trivial here.
      const divisionId = spec.directDivisionId ?? 'general';
      const workerCount = Math.max(1, spec.directWorkerCount ?? 2);
      president.children = Array.from({ length: workerCount }, (_unused, index): RoleNode => {
        const id = `${spec.companyId}:worker:${divisionId}:${index}`;
        const assignment = spec.workerAssignments?.[id];
        return {
          id,
          role: 'worker',
          name: `${presidentName} Worker ${index + 1}`,
          divisionId,
          ...(assignment ? { assignment } : {}),
          children: [],
        };
      });
      return { companyId: spec.companyId, root: president };
    }

    // ── Large task (criterion 3.2): full hierarchy President → heads → workers.
    president.children = spec.divisions.map((division) => {
      const head: RoleNode = {
        id: `${spec.companyId}:head:${division.divisionId}`,
        role: 'division-head',
        name: division.headName ?? `${division.name} Lead`,
        divisionId: division.divisionId,
        ...(division.responsibilities ? { responsibilities: division.responsibilities } : {}),
        ...(division.assignment ? { assignment: division.assignment } : {}),
        children: [],
      };
      const workerCount = Math.max(0, division.workerCount);
      head.children = Array.from({ length: workerCount }, (_unused, index): RoleNode => {
        const id = `${spec.companyId}:worker:${division.divisionId}:${index}`;
        const assignment = spec.workerAssignments?.[id];
        return {
          id,
          role: 'worker',
          name: `${division.name} Worker ${index + 1}`,
          divisionId: division.divisionId,
          ...(assignment ? { assignment } : {}),
          children: [],
        };
      });
      return head;
    });

    return { companyId: spec.companyId, root: president };
  };

  /** Ensure a backing team exists for the structure, creating one on first use. */
  const ensureTeam = async (structure: CompanyStructure): Promise<TeamHandle> => {
    const cached = teamByCompany.get(structure.companyId);
    if (cached) return cached;
    const handle = await teamGateway.createTeam({
      companyId: structure.companyId,
      name: `Company ${structure.companyId}`,
      president: structure.root,
    });
    teamByCompany.set(structure.companyId, handle);
    return handle;
  };

  /**
   * Acquire a run slot for one agent. With a coordinator, this awaits a lease
   * (which queues until budget frees — criterion 3.12). Without one, it falls
   * back to the hardcoded semaphore. The returned `release` is idempotent.
   */
  const acquireAgentSlot = async (estCostMB: number): Promise<AgentSlotLease> => {
    if (resourceCoordinator) {
      const lease = await resourceCoordinator.requestLease({ kind: AGENT_TASK_KIND, estCostMB });
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          resourceCoordinator.releaseLease(lease.id);
        },
      };
    }
    // TODO(lease): coordinator not wired — fall back to a fixed parallelism cap.
    const releaseFn = await fallbackSemaphore!.acquire();
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        releaseFn();
      },
    };
  };

  /** Record a worker's outcome into its division head's `memory.md` (best-effort). */
  const recordOutcomeToHead = async (headAgentId: string, outcome: WorkerOutcome): Promise<void> => {
    const preview =
      outcome.result.length > MEMORY_RESULT_PREVIEW_CHARS
        ? `${outcome.result.slice(0, MEMORY_RESULT_PREVIEW_CHARS)}…`
        : outcome.result;
    const entry = `[delegation] ${outcome.divisionId}/${outcome.nodeId} → ${preview}`;
    try {
      await memoryStore.appendMemory(headAgentId, entry);
    } catch (error) {
      // Memory is auxiliary; never fail a delegation because the journal write failed.
      console.warn(`[Company] Failed to record delegation outcome to "${headAgentId}":`, error);
    }
  };

  /** Delegate one task to one worker: brief → lease → spawn flat → await → release. */
  const delegateToWorker = async (
    companyId: string,
    teamId: string,
    worker: RoleNode,
    request: DelegationRequestInput
  ): Promise<WorkerOutcome> => {
    const divisionId = worker.divisionId;
    if (!divisionId) {
      throw new Error(`[Company] Worker node "${worker.id}" has no divisionId; cannot attach division context.`);
    }

    const prompt = request.taskByDivision?.[divisionId] ?? request.goal;

    // Attach the company + division context to the task (criteria 3.8 / 3.9).
    // Throws if the division is not registered in ContextLayering — the caller
    // is responsible for registering every division used by the structure.
    const briefing = contextLayering.buildDelegationContext({
      divisionId,
      taskPrompt: prompt,
      toAgentId: worker.id,
    });

    // Resolve how this worker's CLI is invoked (locked call template, criterion 3.6).
    const call = await callTemplateManager.buildCall(templateKeyFor(companyId, worker.id), briefing.renderedPrompt);

    const estCostMB = worker.estCostMB ?? request.estCostMBPerAgent ?? DEFAULT_AGENT_EST_COST_MB;
    const slot = await acquireAgentSlot(estCostMB);
    try {
      // FLATTEN: regardless of where `worker` sits in the role tree, it is
      // spawned as a flat Team Mode Teammate under the single Leader.
      const spawned = await teamGateway.spawnTeammate({ teamId, node: worker, call });

      await teamGateway.sendMessage({
        teamId,
        toSlotId: spawned.slotId,
        message: { ...briefing.mailbox, toAgentId: spawned.slotId },
      });

      const result = await teamGateway.awaitResult({ teamId, slotId: spawned.slotId });

      const outcome: WorkerOutcome = { divisionId, nodeId: worker.id, slotId: spawned.slotId, prompt, result };
      await recordOutcomeToHead(briefing.division.headAgentId, outcome);

      // Ephemeral worker — tear it down once done (criterion 3.3). Best-effort.
      if (teamGateway.stopTeammate) {
        try {
          await teamGateway.stopTeammate({ teamId, slotId: spawned.slotId });
        } catch (error) {
          console.warn(`[Company] Failed to stop teammate "${spawned.slotId}":`, error);
        }
      }

      return outcome;
    } finally {
      slot.release();
    }
  };

  const delegate = async (structure: CompanyStructure, request: DelegationRequestInput): Promise<DelegationOutcome> => {
    const team = await ensureTeam(structure);
    const workers = collectWorkers(structure.root);

    // Launch every worker concurrently. Parallelism is bounded by the resource
    // coordinator (each `delegateToWorker` awaits a lease) — NOT by this loop —
    // so the live count tracks free RAM (criterion 3.12).
    const outcomes = await Promise.all(
      workers.map((worker) => delegateToWorker(structure.companyId, team.teamId, worker, request))
    );

    return { companyId: structure.companyId, teamId: team.teamId, outcomes };
  };

  return { createStructure, delegate };
};
