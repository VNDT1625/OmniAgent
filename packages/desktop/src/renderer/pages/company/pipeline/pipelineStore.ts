/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pipeline store — the renderer-side state the Manager popup reads while a
 * company run is in progress (Requirement 7). It reduces the engine's
 * {@link PipelineEvent} stream into a snapshot: the per-role run state (for the
 * recursive tree board), the transcript, the produced artifacts, and the pending
 * approvals. Pure reducer + a tiny subscribe/emit, so it is unit-testable and
 * framework-agnostic (the React hook simply subscribes to it).
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import type {
  Artifact,
  PendingApproval,
  PipelineEvent,
  PipelineMessage,
  PipelinePhase,
  RoleRunState,
} from './pipelineTypes';

/** The full snapshot the UI renders. */
export type PipelineSnapshot = {
  /** Lifecycle phase. */
  phase: PipelinePhase;
  /** Active run id. */
  runId: string | null;
  /** Root role node id. */
  rootId: string | null;
  /** Per-role run state, keyed by node id. */
  states: Record<string, RoleRunState>;
  /** Ordered transcript. */
  messages: PipelineMessage[];
  /** Produced artifacts. */
  artifacts: Artifact[];
  /** Approvals/permissions awaiting a decision. */
  pending: PendingApproval[];
  /** Final summary (when finished). */
  summary: string;
  /** Error message (when phase is `error`). */
  error: string | null;
};

/** The initial empty snapshot. */
export const emptySnapshot = (): PipelineSnapshot => ({
  phase: 'idle',
  runId: null,
  rootId: null,
  states: {},
  messages: [],
  artifacts: [],
  pending: [],
  summary: '',
  error: null,
});

/** Apply one event to a snapshot, returning the next snapshot (immutable). */
export const reducePipeline = (state: PipelineSnapshot, event: PipelineEvent): PipelineSnapshot => {
  switch (event.type) {
    case 'run-started': {
      const states: Record<string, RoleRunState> = {};
      for (const s of event.states) states[s.nodeId] = s;
      return { ...emptySnapshot(), phase: 'running', runId: event.runId, rootId: event.rootId, states };
    }
    case 'role-status': {
      return { ...state, states: { ...state.states, [event.state.nodeId]: event.state } };
    }
    case 'message': {
      return { ...state, messages: [...state.messages, event.message] };
    }
    case 'execute-started': {
      const prev = state.states[event.nodeId];
      if (!prev) return state;
      return {
        ...state,
        states: { ...state.states, [event.nodeId]: { ...prev, conversationId: event.conversationId } },
      };
    }
    case 'execute-finished': {
      return state; // status transitions are carried by role-status events
    }
    case 'approval': {
      // De-dupe by id (idempotent).
      if (state.pending.some((p) => p.id === event.request.id)) return state;
      return { ...state, pending: [...state.pending, event.request] };
    }
    case 'approval-resolved': {
      return { ...state, pending: state.pending.filter((p) => p.id !== event.decision.requestId) };
    }
    case 'artifact': {
      if (state.artifacts.some((a) => a.id === event.artifact.id)) return state;
      return { ...state, artifacts: [...state.artifacts, event.artifact] };
    }
    case 'test-started':
    case 'test-finished': {
      return state; // surfaced via artifacts + role-status
    }
    case 'run-finished': {
      return {
        ...state,
        phase: event.status === 'stopped' ? 'stopped' : 'finished',
        summary: event.summary,
        pending: [],
      };
    }
    case 'run-error': {
      return { ...state, phase: 'error', error: event.message, pending: [] };
    }
    default:
      return state;
  }
};

/** A subscribable store wrapping the reducer. */
export type PipelineStore = {
  /** Current snapshot. */
  getSnapshot: () => PipelineSnapshot;
  /** Feed an event (applies the reducer + notifies subscribers). */
  dispatch: (event: PipelineEvent) => void;
  /** Subscribe to snapshot changes; returns an unsubscribe function. */
  subscribe: (listener: (snapshot: PipelineSnapshot) => void) => () => void;
  /** Reset to the empty snapshot (e.g. before a new run). */
  reset: () => void;
};

/**
 * Create an in-memory pipeline store.
 *
 * @param initial Optional snapshot to seed the store with (used to restore a
 * persisted run after a renderer reload). Defaults to the empty snapshot.
 */
export const createPipelineStore = (initial?: PipelineSnapshot): PipelineStore => {
  let snapshot = initial ?? emptySnapshot();
  const listeners = new Set<(s: PipelineSnapshot) => void>();

  const notify = (): void => {
    for (const l of listeners) l(snapshot);
  };

  return {
    getSnapshot: () => snapshot,
    dispatch: (event) => {
      snapshot = reducePipeline(snapshot, event);
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: () => {
      snapshot = emptySnapshot();
      notify();
    },
  };
};
