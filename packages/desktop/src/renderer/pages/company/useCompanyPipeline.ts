/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * React hook driving the **real-work** company pipeline (spec
 * agent-company-pipeline). It exposes the live snapshot (tree states,
 * transcript, artifacts, pending approvals) to the Manager popup and forwards
 * the boss's approval/stop actions to the run.
 *
 * ## Survives tab switch / popup close
 *
 * The run used to live inside this hook, so unmounting the Company page (a tab
 * switch) or closing the Manager popup tore the run down via an unmount
 * cleanup — the user's "prompt test" vanished. The run now lives in a
 * **module-level session** keyed by company id (see {@link getSession}), which
 * is independent of any React component. Mounting the hook simply *attaches* to
 * that session and subscribes to its store; unmounting detaches without
 * stopping the run. Re-opening the page re-attaches and shows the live state.
 *
 * The latest snapshot is also mirrored to `sessionStorage` so a renderer reload
 * (refresh) can restore what the run produced. The recursive pipeline executes
 * in the renderer, so a hard reload cannot resume the loop itself — a snapshot
 * still marked `running` is restored as `stopped` (interrupted) with its
 * transcript/board intact. (The lightweight "Conversation" engine runs in the
 * Main process and genuinely continues across a reload — see
 * `useCompanyConversation`.)
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import type { CompanyStructure } from '@process/company/companyOrchestrator';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { runCompany, type CompanyRunHandle } from './pipeline/companyPipeline';
import {
  createPipelineStore,
  emptySnapshot,
  type PipelineSnapshot,
  type PipelineStore,
} from './pipeline/pipelineStore';
import type { RunConfig } from './pipeline/pipelineTypes';

/** The full input needed to start (or auto-resume) a company run. */
export type PipelineRunInput = {
  companyName: string;
  structure: CompanyStructure;
  rules: string[];
  goal: string;
  model?: string;
  language: string;
  config?: RunConfig;
};

/** Shape returned by {@link useCompanyPipeline}. */
export type UseCompanyPipeline = {
  /** Live snapshot of the run (tree states, transcript, artifacts, pending, phase). */
  snapshot: PipelineSnapshot;
  /** Whether a run is in progress. */
  running: boolean;
  /** Start a recursive real-work run for `goal`. No-op while one is running. */
  start: (input: PipelineRunInput) => void;
  /** Approve or deny a pending approval/permission (boss authority). */
  resolveApproval: (requestId: string, approved: boolean, note?: string) => void;
  /** Stop the in-flight run. */
  stop: () => void;
};

// ---------------------------------------------------------------------------
// Persistent, component-independent sessions (one per company)
// ---------------------------------------------------------------------------

/** sessionStorage key holding the per-company pipeline snapshot (reload survival). */
const PIPELINE_SNAPSHOT_KEY = 'aionui.company.pipeline.snapshots';

/**
 * sessionStorage key holding the per-company run INPUT (goal + structure + rules
 * + model + config). Persisting the input lets a run that was interrupted by a
 * renderer reload (F5) be **automatically restarted** from its goal — the user
 * never asked it to stop, so we resume without prompting. (The renderer-driven
 * loop cannot resume mid-flight, so "resume" means re-running the same goal.)
 */
const PIPELINE_INPUT_KEY = 'aionui.company.pipeline.inputs';

/** Persisted snapshot map: company id → last snapshot. */
type PersistMap = Record<string, PipelineSnapshot>;

/** Persisted run-input map: company id → last run input. */
type InputMap = Record<string, PipelineRunInput>;

/** Read the persisted snapshot map from sessionStorage (safe; empty on failure). */
const readPersisted = (): PersistMap => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(PIPELINE_SNAPSHOT_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as PersistMap;
  } catch {
    return {};
  }
};

/** Persist one company's snapshot (best-effort; merges into the map). */
const writePersisted = (companyId: string, snapshot: PipelineSnapshot): void => {
  if (typeof window === 'undefined') return;
  try {
    const map = readPersisted();
    map[companyId] = snapshot;
    window.sessionStorage.setItem(PIPELINE_SNAPSHOT_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage failures (private mode / quota) — persistence is non-critical.
  }
};

/** Read the persisted run-input map from sessionStorage (safe; empty on failure). */
const readInputs = (): InputMap => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(PIPELINE_INPUT_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as InputMap;
  } catch {
    return {};
  }
};

/** Persist one company's run input (best-effort; merges into the map). */
const writeInput = (companyId: string, input: PipelineRunInput): void => {
  if (typeof window === 'undefined') return;
  try {
    const map = readInputs();
    map[companyId] = input;
    window.sessionStorage.setItem(PIPELINE_INPUT_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage failures — auto-resume is a best-effort convenience.
  }
};

/** Forget one company's persisted run input (e.g. after it finishes/stops cleanly). */
const clearInput = (companyId: string): void => {
  if (typeof window === 'undefined') return;
  try {
    const map = readInputs();
    if (companyId in map) {
      delete map[companyId];
      window.sessionStorage.setItem(PIPELINE_INPUT_KEY, JSON.stringify(map));
    }
  } catch {
    // Ignore.
  }
};

/** A persistent pipeline run for one company, independent of any component. */
type PipelineSession = {
  /** The store the run feeds events into (subscribed by the hook). */
  store: PipelineStore;
  /** The live run handle, or `null` when no run is active. */
  handle: CompanyRunHandle | null;
};

/** Live sessions, keyed by company id. Outlives component mounts. */
const sessions = new Map<string, PipelineSession>();

/**
 * Restore a persisted snapshot for a fresh module load (renderer reload). The
 * renderer-driven run cannot survive a hard reload, so a snapshot still marked
 * `running` is downgraded to `stopped` (interrupted) and its pending gates
 * cleared — the transcript/board are kept so the user sees where it got to.
 *
 * When an interrupted run also has a persisted input, the session will
 * AUTO-RESUME it (see {@link getSession}) — the stop was outside the user's
 * intent, so we restart the goal without asking.
 */
const restoreSnapshot = (companyId: string): PipelineSnapshot | undefined => {
  const persisted = readPersisted()[companyId];
  if (!persisted) return undefined;
  if (persisted.phase === 'running') return { ...persisted, phase: 'stopped', pending: [] };
  return persisted;
};

/** Whether a snapshot represents a run interrupted by a reload (was running). */
const wasInterrupted = (companyId: string): boolean => readPersisted()[companyId]?.phase === 'running';

/** Get (or lazily create) the persistent session for a company. */
const getSession = (companyId: string): PipelineSession => {
  const existing = sessions.get(companyId);
  if (existing) return existing;
  // Capture interruption state BEFORE restoreSnapshot downgrades it.
  const interrupted = wasInterrupted(companyId);
  const store = createPipelineStore(restoreSnapshot(companyId));
  const session: PipelineSession = { store, handle: null };
  // Mirror every snapshot change to sessionStorage so a reload can restore it.
  store.subscribe((snap) => writePersisted(companyId, snap));
  // Forget the persisted input the moment the run reaches a terminal state, so
  // a later F5 does not auto-resume a run that already finished / errored /
  // was stopped by the user.
  store.subscribe((snap) => {
    if (snap.phase === 'finished' || snap.phase === 'error' || snap.phase === 'stopped') {
      clearInput(companyId);
    }
  });
  sessions.set(companyId, session);

  // AUTO-RESUME: a run interrupted by a renderer reload (F5) is restarted from
  // its goal — the user never asked it to stop. We only resume when the saved
  // input still matches the company (and a model is known); otherwise the saved
  // input is stale and is cleared. Deferred a tick so the session is registered
  // before the new run dispatches its first event.
  if (interrupted) {
    const input = readInputs()[companyId];
    if (input && input.goal && input.structure) {
      setTimeout(() => {
        // Guard: do not double-start if something already kicked off a run.
        if (session.handle || session.store.getSnapshot().phase === 'running') return;
        session.handle = runCompany({
          companyId,
          companyName: input.companyName,
          structure: input.structure,
          rules: input.rules,
          goal: input.goal,
          model: input.model,
          language: input.language,
          config: input.config,
          store: session.store,
        });
      }, 0);
    } else {
      clearInput(companyId);
    }
  }

  return session;
};

/** Guard so the app-level resume scan runs at most once per renderer load. */
let resumeScanDone = false;

/**
 * App-level auto-resume scan (call once on renderer boot).
 *
 * The per-session auto-resume in {@link getSession} only fires when a component
 * attaches to that session (i.e. when the user opens the Company / Manager page).
 * That means a run interrupted by an F5 would NOT restart until the user happened
 * to navigate back to Company. The user never asked the run to stop, so this scan
 * proactively re-attaches to every company whose run was interrupted mid-flight —
 * restarting it from its goal in the background, regardless of the current route.
 *
 * Idempotent: `getSession` returns the existing session (no double-start) if the
 * page later mounts, and this scan guards itself with {@link resumeScanDone}.
 *
 * Resume criteria: a persisted run INPUT still exists for the company (it is
 * cleared on a clean finish / user stop) AND the last persisted snapshot was
 * `running` (interrupted) — `getSession` performs the actual restart.
 */
export const resumeInterruptedCompanyRuns = (): void => {
  if (resumeScanDone) return;
  resumeScanDone = true;
  if (typeof window === 'undefined') return;
  const inputs = readInputs();
  const snapshots = readPersisted();
  for (const companyId of Object.keys(inputs)) {
    const input = inputs[companyId];
    if (!input || !input.goal || !input.structure) continue;
    // Only resume runs that were genuinely interrupted mid-flight. A terminal
    // snapshot would already have cleared the input, but guard defensively.
    if (snapshots[companyId]?.phase !== 'running') continue;
    // Touch the session: getSession sees the interruption and schedules the
    // restart from the saved goal.
    getSession(companyId);
  }
};

/**
 * Stop every live run and clear all sessions + persisted snapshots. Intended for
 * deterministic test teardown; not used by the app.
 */
export const resetCompanyPipelineSessions = (): void => {
  resumeScanDone = false;
  for (const session of sessions.values()) session.handle?.stop();
  sessions.clear();
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.removeItem(PIPELINE_SNAPSHOT_KEY);
      window.sessionStorage.removeItem(PIPELINE_INPUT_KEY);
    } catch {
      // Ignore.
    }
  }
};

/**
 * Manage a company's real-work pipeline run.
 *
 * @param companyId The active company id (runs are scoped to it).
 */
export function useCompanyPipeline(companyId: string | null): UseCompanyPipeline {
  const session = useMemo(() => (companyId ? getSession(companyId) : null), [companyId]);
  const [snapshot, setSnapshot] = useState<PipelineSnapshot>(() => session?.store.getSnapshot() ?? emptySnapshot());

  // Attach to the session's store (no teardown of the run on unmount).
  useEffect(() => {
    if (!session) {
      setSnapshot(emptySnapshot());
      return;
    }
    setSnapshot(session.store.getSnapshot());
    return session.store.subscribe(setSnapshot);
  }, [session]);

  const start = useCallback<UseCompanyPipeline['start']>(
    (input) => {
      if (!companyId || !session) return;
      // No-op while a run for this company is already in progress.
      if (session.store.getSnapshot().phase === 'running' && session.handle) return;
      // Persist the run input so an F5 mid-run can AUTO-RESUME from this goal
      // (the user never asked it to stop). Cleared on a clean finish / user stop.
      writeInput(companyId, input);
      session.handle = runCompany({
        companyId,
        companyName: input.companyName,
        structure: input.structure,
        rules: input.rules,
        goal: input.goal,
        model: input.model,
        language: input.language,
        config: input.config,
        store: session.store,
      });
    },
    [companyId, session]
  );

  const resolveApproval = useCallback(
    (requestId: string, approved: boolean, note?: string) => {
      session?.handle?.resolveApproval({ requestId, approved, note });
    },
    [session]
  );

  const stop = useCallback(() => {
    // A manual stop IS the user's intent — forget the saved input so a later F5
    // does not auto-resume a run the user deliberately stopped.
    if (companyId) clearInput(companyId);
    session?.handle?.stop();
  }, [companyId, session]);

  return { snapshot, running: snapshot.phase === 'running', start, resolveApproval, stop };
}
