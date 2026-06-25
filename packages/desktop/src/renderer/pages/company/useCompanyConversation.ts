/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer hook driving the live company conversation (Requirement 3 "Phần 2":
 * boss ↔ employee dialogue + boss approval + status board).
 *
 * It exposes the transcript, the per-participant status board (who is talking to
 * whom / who is doing what), and the queue of pending permission requests the
 * boss must answer. It starts/cancels a run and resolves permissions through
 * {@link companyClient}.
 *
 * ## Survives tab switch / popup close / refresh
 *
 * The conversation engine itself runs in the **Main process**
 * (`process/company/companyConversation.ts`), so it keeps running when the
 * Company page unmounts (a tab switch) or even across a renderer reload
 * (refresh). The earlier hook lost the run on unmount because all run state
 * lived in component state and the event listener was per-component — when the
 * page remounted, `activeRunRef` was `null` again and live events were ignored.
 *
 * State now lives in a **module-level session** keyed by company id, fed by a
 * single always-on subscription to the Main-process event stream
 * ({@link onCompanyConversationEvent}). The hook attaches to that session and
 * mirrors it into React state; unmounting only detaches. The session is also
 * mirrored to `sessionStorage`, so after a refresh the hook restores the last
 * known transcript/board and the still-running Main-process run keeps streaming
 * straight back into it.
 *
 * Process boundary: Renderer module. No Node.js APIs — all backend access goes
 * through the company IPC client.
 */

import type {
  ConversationEvent,
  ConversationMessage,
  Participant,
  ParticipantStatus,
  PermissionRequest,
} from '@process/company/companyConversation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { companyClient, onCompanyConversationEvent } from './companyBridgeClient';

/** Lifecycle phase of a conversation run. */
export type ConversationPhase = 'idle' | 'running' | 'finished' | 'stopped' | 'error';

/** Shape returned by {@link useCompanyConversation}. */
export type UseCompanyConversation = {
  /** Current run phase. */
  phase: ConversationPhase;
  /** Active run id (null when idle). */
  runId: string | null;
  /** Participant roster for the active run. */
  participants: Participant[];
  /** Live status board, keyed by participant id. */
  statuses: Record<string, ParticipantStatus>;
  /** Ordered transcript of who said what to whom. */
  messages: ConversationMessage[];
  /** Permission requests still awaiting the boss's decision. */
  pending: PermissionRequest[];
  /** The President's final summary (when finished). */
  summary: string;
  /** Error message (when phase is `error`). */
  error: string | null;
  /** Start a conversation for `goal`. No-op while one is already running. */
  start: (goal: string, model?: string) => Promise<void>;
  /** Approve or deny a pending permission request (boss authority). */
  resolve: (requestId: string, approved: boolean, note?: string) => Promise<void>;
  /** Cancel the in-flight run (best-effort). */
  cancel: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// Persistent, component-independent session state (one per company)
// ---------------------------------------------------------------------------

/** The serialisable state of a company's conversation run. */
type ConversationState = {
  phase: ConversationPhase;
  runId: string | null;
  participants: Participant[];
  statuses: Record<string, ParticipantStatus>;
  messages: ConversationMessage[];
  pending: PermissionRequest[];
  summary: string;
  error: string | null;
};

/** The empty state. */
const emptyState = (): ConversationState => ({
  phase: 'idle',
  runId: null,
  participants: [],
  statuses: {},
  messages: [],
  pending: [],
  summary: '',
  error: null,
});

/** sessionStorage key holding the per-company conversation state (reload survival). */
const CONVERSATION_STATE_KEY = 'aionui.company.conversation.state';

/** Read the persisted state map from sessionStorage (safe; empty on failure). */
const readPersisted = (): Record<string, ConversationState> => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(CONVERSATION_STATE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, ConversationState>;
  } catch {
    return {};
  }
};

/** Persist one company's conversation state (best-effort). */
const writePersisted = (companyId: string, state: ConversationState): void => {
  if (typeof window === 'undefined') return;
  try {
    const map = readPersisted();
    map[companyId] = state;
    window.sessionStorage.setItem(CONVERSATION_STATE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage failures — persistence is non-critical.
  }
};

/** A persistent conversation session for one company, independent of any component. */
type ConversationSession = {
  /** The current state. */
  state: ConversationState;
  /** Subscribers (the mounted hooks). */
  listeners: Set<(state: ConversationState) => void>;
  /** Notify subscribers + persist. */
  set: (next: ConversationState) => void;
};

/** Live sessions, keyed by company id. Outlives component mounts. */
const sessions = new Map<string, ConversationSession>();

/**
 * The company whose session should receive a `run-started` event (and any event
 * whose run id matches no existing session). The Main-process event stream is
 * company-agnostic, so we route new runs to the most recently active company —
 * the one the user is looking at / just started a run for. Set on hook mount and
 * when a run is started.
 */
let currentCompanyId: string | null = null;

/**
 * Restore a persisted session for a fresh module load (renderer reload). The
 * Main-process engine keeps running, so a `running` snapshot is kept as-is and
 * the always-on listener picks the stream back up.
 */
const getSession = (companyId: string): ConversationSession => {
  const existing = sessions.get(companyId);
  if (existing) return existing;
  const persisted = readPersisted()[companyId];
  const session: ConversationSession = {
    state: persisted ?? emptyState(),
    listeners: new Set(),
    set: (next) => {
      session.state = next;
      writePersisted(companyId, next);
      for (const l of session.listeners) l(next);
    },
  };
  sessions.set(companyId, session);
  return session;
};

/**
 * Reduce one streamed conversation event into a company's session state. A
 * `run-started` event claims the session for its run id; later events for a
 * *different* run id are ignored so a stale stream cannot clobber a newer run.
 */
const applyEvent = (state: ConversationState, event: ConversationEvent): ConversationState => {
  switch (event.type) {
    case 'run-started':
      return {
        phase: 'running',
        runId: event.runId,
        participants: event.participants,
        statuses: {},
        messages: [],
        pending: [],
        summary: '',
        error: null,
      };
    case 'status':
      if (event.runId !== state.runId) return state;
      return { ...state, statuses: { ...state.statuses, [event.status.id]: event.status } };
    case 'message':
      if (event.runId !== state.runId) return state;
      return { ...state, messages: [...state.messages, event.message] };
    case 'permission':
      if (event.runId !== state.runId) return state;
      return { ...state, pending: [...state.pending, event.request] };
    case 'permission-resolved':
      if (event.runId !== state.runId) return state;
      return { ...state, pending: state.pending.filter((p) => p.id !== event.decision.requestId) };
    case 'run-finished':
      if (event.runId !== state.runId) return state;
      return {
        ...state,
        summary: event.summary,
        pending: [],
        phase: event.status === 'stopped' ? 'stopped' : 'finished',
      };
    case 'run-error':
      if (event.runId !== state.runId) return state;
      return { ...state, error: event.message, pending: [], phase: 'error' };
    default:
      return state;
  }
};

/**
 * Wire ONE always-on subscription to the Main-process event stream. Because the
 * engine streams events even while no Company page is mounted, this module-level
 * listener keeps every company's session up to date regardless of the UI, so a
 * tab switch or refresh never drops live progress. Routing is by run id: an
 * event is applied to whichever session currently owns that run.
 */
let streamWired = false;
const ensureStreamWired = (): void => {
  if (streamWired || typeof window === 'undefined') return;
  streamWired = true;
  onCompanyConversationEvent(({ event }) => {
    // Route by run id to the owning session first (the common case).
    for (const session of sessions.values()) {
      if (session.state.runId && session.state.runId === event.runId) {
        session.set(applyEvent(session.state, event));
        return;
      }
    }
    // A `run-started` (or the first event of a run whose id we have not seen)
    // belongs to the company that most recently mounted / started a run.
    if (event.type === 'run-started' && currentCompanyId) {
      const session = sessions.get(currentCompanyId);
      if (session) session.set(applyEvent({ ...session.state, runId: event.runId }, event));
    }
  });
};

/**
 * Stop tracking and clear all sessions + persisted state. Intended for
 * deterministic test teardown; not used by the app.
 */
export const resetCompanyConversationSessions = (): void => {
  sessions.clear();
  currentCompanyId = null;
  streamWired = false;
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.removeItem(CONVERSATION_STATE_KEY);
    } catch {
      // Ignore.
    }
  }
};

/**
 * Manage a single company's live conversation.
 *
 * @param companyId The active company; conversations are scoped to it.
 */
export function useCompanyConversation(companyId: string | null): UseCompanyConversation {
  const session = useMemo(() => {
    if (!companyId) return null;
    ensureStreamWired();
    currentCompanyId = companyId;
    return getSession(companyId);
  }, [companyId]);
  const [state, setState] = useState<ConversationState>(() => session?.state ?? emptyState());

  // Attach to the session (no teardown of the run on unmount).
  useEffect(() => {
    if (!session) {
      setState(emptyState());
      return;
    }
    currentCompanyId = companyId;
    setState(session.state);
    session.listeners.add(setState);
    return () => {
      session.listeners.delete(setState);
    };
  }, [session, companyId]);

  const start = useCallback(
    async (goal: string, model?: string): Promise<void> => {
      if (!companyId || !session || session.state.phase === 'running') return;
      // This company owns the next run that starts on the stream.
      currentCompanyId = companyId;
      // Mark the session as awaiting a run so the stream's `run-started` claims it.
      session.set({ ...emptyState(), phase: 'running' });
      try {
        const res = await companyClient.runConversation.invoke({ companyId, goal, model });
        // The stream drives most state; this only handles the terminal envelope
        // in case the run finished before any event was observed.
        if (res && res.ok) {
          if (res.data.status === 'error') {
            session.set({ ...session.state, error: session.state.error ?? 'The conversation failed.', phase: 'error' });
          }
        } else {
          const failure = res as { ok: false; error?: string; code?: string } | undefined;
          session.set({ ...session.state, error: failure?.error ?? 'The conversation failed.', phase: 'error' });
        }
      } catch (e) {
        session.set({ ...session.state, error: e instanceof Error ? e.message : String(e), phase: 'error' });
      }
    },
    [companyId, session]
  );

  const resolve = useCallback(
    async (requestId: string, approved: boolean, note?: string): Promise<void> => {
      // Optimistically drop it from the queue; the stream confirms via
      // `permission-resolved`.
      if (session) session.set({ ...session.state, pending: session.state.pending.filter((p) => p.id !== requestId) });
      try {
        await companyClient.resolvePermission.invoke({ requestId, approved, note });
      } catch {
        // Non-fatal; the run will time out on its own branch if the resolve failed.
      }
    },
    [session]
  );

  const cancel = useCallback(async (): Promise<void> => {
    const id = session?.state.runId;
    if (!id) return;
    try {
      await companyClient.cancelConversation.invoke({ runId: id });
    } catch {
      // Best-effort.
    }
  }, [session]);

  return {
    phase: state.phase,
    runId: state.runId,
    participants: state.participants,
    statuses: state.statuses,
    messages: state.messages,
    pending: state.pending,
    summary: state.summary,
    error: state.error,
    start,
    resolve,
    cancel,
  };
}
