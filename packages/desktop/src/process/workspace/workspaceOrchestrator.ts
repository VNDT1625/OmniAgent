/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Workspace orchestrator — runs several sub-agents **in parallel** inside one
 * chat, each driving its own live surface (a browser tab or an editor file).
 *
 * This realises the user's "vừa search web A vừa edit B" flow: a single chat
 * turn fans out into N independent sub-agents that work concurrently, each with
 * its own frame the user can watch. The orchestrator owns three concerns and
 * nothing else:
 *
 * 1. **Concurrency budget (Requirement 5, criterion 3.12).** Every sub-agent is
 *    a heavy task, so before a surface starts the orchestrator acquires a
 *    ResourceCoordinator lease of `TaskKind: 'agent'`. The coordinator decides
 *    how many run at once on this machine; the rest wait in `queued` and start
 *    as leases free up. The lease is released in a `finally` so a crash can't
 *    leak budget.
 * 2. **Isolation.** Each surface gets its own {@link ISurfaceRunner} + its own
 *    {@link AbortController}; a failure or cancel of one surface never affects
 *    the others. Browser surfaces drive their own tab (tab-isolated input,
 *    criterion 1.3); editor surfaces touch only their own file. They never share
 *    one mouse/keyboard.
 * 3. **Streaming.** Per-surface lifecycle + tool narration is pushed through the
 *    injected {@link WorkspaceEventSink} so the renderer can render one live,
 *    self-updating frame per surface.
 *
 * The concrete browser/editor machinery lives behind the injected
 * {@link ISurfaceRunner}s (see `surfaceRunners.ts`), so this module is pure
 * orchestration and unit-testable with fake runners + a fake coordinator.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { IResourceCoordinator } from '@process/resource/resourceCoordinator';
import { getResourceCoordinator } from '@process/resource/resourceCoordinator';
import {
  fileTitle,
  hostTitle,
  SURFACE_AGENT_COST_MB,
  type ISurfaceRunner,
  type SurfaceKind,
  type SurfaceSpec,
  type SurfaceState,
  type SurfaceStatus,
  type WorkspaceEventSink,
  type WorkspaceRunResult,
} from './surfaceTypes';

/** A workspace run grouped under one stable id (one user request). */
export type RunWorkspaceRequest = {
  /** Stable id for this run (used to address cancellation). */
  runId: string;
  /** The sub-agent tasks to run concurrently. */
  surfaces: SurfaceSpec[];
};

/** Injected dependencies for {@link createWorkspaceOrchestrator}. */
export type WorkspaceOrchestratorDeps = {
  /** A runner per surface kind. */
  runners: Record<SurfaceKind, ISurfaceRunner>;
  /** Resource gate. Defaults to the shared application coordinator. */
  coordinator?: IResourceCoordinator;
  /** Unique surface-id generator. Defaults to `crypto.randomUUID`. */
  generateId?: () => string;
  /** RAM (MB) charged per sub-agent lease. Defaults to {@link SURFACE_AGENT_COST_MB}. */
  agentCostMB?: number;
};

/** Public contract of the workspace orchestrator. */
export type IWorkspaceOrchestrator = {
  /**
   * Run all surfaces of a request concurrently, streaming progress through
   * `onEvent` and resolving once every surface has settled. Resolves even when
   * some surfaces error (their failure is reported per-surface); rejects only on
   * programmer error.
   */
  run: (request: RunWorkspaceRequest, onEvent: WorkspaceEventSink) => Promise<WorkspaceRunResult>;
  /** Cancel every in-flight surface of a run (best-effort, cooperative). */
  cancel: (runId: string) => void;
};

/** Per-surface bookkeeping during a run. */
type SurfaceTask = {
  state: SurfaceState;
  controller: AbortController;
};

/** Initial title for a spec before its runner refines it. */
const initialTitle = (spec: SurfaceSpec): string =>
  spec.kind === 'browser' ? hostTitle(spec.url) : fileTitle(spec.filePath);

/**
 * Create an {@link IWorkspaceOrchestrator} from injected runners + coordinator.
 */
export const createWorkspaceOrchestrator = (deps: WorkspaceOrchestratorDeps): IWorkspaceOrchestrator => {
  const coordinator = deps.coordinator ?? getResourceCoordinator();
  const generateId = deps.generateId ?? (() => crypto.randomUUID());
  const agentCostMB = deps.agentCostMB ?? SURFACE_AGENT_COST_MB;

  /** Active runs, so `cancel(runId)` can abort every surface in a run. */
  const runs = new Map<string, SurfaceTask[]>();

  /**
   * Drive one surface end-to-end: lease → prepare → run → settle. Always
   * resolves (failures are reported as events + a non-`done` status) so one bad
   * surface never rejects the whole run.
   */
  const driveSurface = async (task: SurfaceTask, spec: SurfaceSpec, onEvent: WorkspaceEventSink): Promise<void> => {
    const runner = deps.runners[spec.kind];
    const { state, controller } = task;

    const setStatus = (status: SurfaceStatus): void => {
      state.status = status;
      onEvent({ type: 'surface-status', id: state.id, status });
    };

    if (controller.signal.aborted) {
      setStatus('stopped');
      return;
    }

    // 1. Wait for an `agent` lease — this is the concurrency throttle. While the
    // promise is pending the surface stays `queued` (the machine is busy).
    const lease = await coordinator.requestLease({ kind: 'agent', estCostMB: agentCostMB });
    if (controller.signal.aborted) {
      coordinator.releaseLease(lease.id);
      setStatus('stopped');
      return;
    }

    setStatus('starting');
    try {
      // 2. Prepare the surface (open the tab / resolve the file) so its frame
      // can appear, then announce it to the renderer.
      const prepared = await runner.prepare(spec);
      state.title = prepared.title;
      state.tabId = prepared.tabId;
      state.filePath = prepared.filePath;
      onEvent({ type: 'surface-created', surface: { ...state } });

      if (controller.signal.aborted) {
        runner.dispose?.(spec, prepared);
        setStatus('stopped');
        return;
      }

      // 3. Run the sub-agent loop, streaming its tool narration.
      setStatus('running');
      const outcome = await runner.run(spec, prepared, {
        surfaceId: state.id,
        signal: controller.signal,
        emit: (progress) => {
          if (progress.type === 'step') {
            state.steps += 1;
            onEvent({ type: 'surface-step', id: state.id, tool: progress.tool, summary: progress.summary });
          } else {
            onEvent({
              type: 'surface-observation',
              id: state.id,
              tool: progress.tool,
              ok: progress.ok,
              summary: progress.summary,
            });
          }
        },
      });

      // 4. Settle.
      state.steps = outcome.steps;
      if (controller.signal.aborted) {
        setStatus('stopped');
      } else {
        state.answer = outcome.answer;
        setStatus('done');
        onEvent({ type: 'surface-final', id: state.id, answer: outcome.answer });
      }
      runner.dispose?.(spec, prepared);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        setStatus('stopped');
      } else {
        state.error = message;
        setStatus('error');
        onEvent({ type: 'surface-error', id: state.id, message });
      }
    } finally {
      coordinator.releaseLease(lease.id);
    }
  };

  return {
    async run(request, onEvent) {
      const tasks: SurfaceTask[] = request.surfaces.map((spec) => ({
        controller: new AbortController(),
        state: {
          id: generateId(),
          kind: spec.kind,
          title: initialTitle(spec),
          status: 'queued',
          steps: 0,
        },
      }));
      runs.set(request.runId, tasks);

      // Announce every surface up-front as `queued` so all frames render
      // immediately (even those still waiting for a lease).
      for (const task of tasks) {
        onEvent({ type: 'surface-created', surface: { ...task.state } });
      }

      try {
        // Kick off every surface concurrently; each awaits its own lease, so the
        // ResourceCoordinator — not this loop — decides the real parallelism.
        await Promise.all(tasks.map((task, i) => driveSurface(task, request.surfaces[i], onEvent)));
        const ok = tasks.every((task) => task.state.status !== 'error');
        onEvent({ type: 'run-complete', ok });
        return { surfaces: tasks.map((task) => ({ ...task.state })), ok };
      } finally {
        runs.delete(request.runId);
      }
    },

    cancel(runId) {
      const tasks = runs.get(runId);
      if (!tasks) return;
      for (const task of tasks) task.controller.abort();
    },
  };
};
