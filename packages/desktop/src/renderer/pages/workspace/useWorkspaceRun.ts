/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer state for a workspace run — several sub-agents working in parallel,
 * each on its own live surface frame.
 *
 * It starts a run through {@link workspaceClient.run}, subscribes to the live
 * `workspace.event` stream, and reduces those events into:
 *
 *  - `surfaces` — the per-surface {@link SurfaceState}s (one live frame each), and
 *  - a per-surface `log` of tool steps so each frame shows its own narration.
 *
 * The hook degrades gracefully when the Main-process bridge is not wired: the
 * `run` promise rejects (or the cancel times out) and `error` is surfaced so the
 * page can show a friendly notice instead of hanging.
 *
 * Renderer-only module: talks to the Main process only via {@link workspaceClient}.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SurfaceState, SurfaceStatus } from '@process/workspace/surfaceTypes';
import type { SurfaceSpec } from '@process/workspace/surfaceTypes';
import { workspaceClient, type WorkspaceEvent } from './workspaceBridgeClient';
import { newRunId } from './constants';

/** One narration line under a surface frame. */
export type SurfaceLogLine = {
  /** Stable key for React lists. */
  id: string;
  /** Tool name (e.g. `navigate`, `write`). */
  tool: string;
  /** Short human label. */
  summary: string;
  /** Step lifecycle: a started step, or its finished observation. */
  status: 'running' | 'ok' | 'fail';
};

/** Status of the whole workspace run. */
export type WorkspaceRunStatus = 'idle' | 'running' | 'done' | 'error';

/** Public shape returned by {@link useWorkspaceRun}. */
export type UseWorkspaceRun = {
  /** The per-surface live state (one frame each), in creation order. */
  surfaces: SurfaceState[];
  /** Per-surface narration log, keyed by surface id. */
  logs: Record<string, SurfaceLogLine[]>;
  /** Overall run status. */
  status: WorkspaceRunStatus;
  /** The most recent run-level error (e.g. bridge not wired), or null. */
  error: string | null;
  /** Start a run from a list of surface specs. */
  start: (surfaces: SurfaceSpec[]) => Promise<void>;
  /** Cancel the in-flight run (all surfaces). */
  cancel: () => void;
};

let counter = 0;
const nextLineId = (): string => `l${Date.now().toString(36)}-${(counter++).toString(36)}`;

/**
 * Manage a single workspace run and its live per-surface state.
 */
export function useWorkspaceRun(): UseWorkspaceRun {
  const [surfaces, setSurfaces] = useState<SurfaceState[]>([]);
  const [logs, setLogs] = useState<Record<string, SurfaceLogLine[]>>({});
  const [status, setStatus] = useState<WorkspaceRunStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const upsertSurface = useCallback((surface: SurfaceState) => {
    setSurfaces((prev) => {
      const idx = prev.findIndex((s) => s.id === surface.id);
      if (idx === -1) return [...prev, surface];
      const next = [...prev];
      next[idx] = { ...next[idx], ...surface };
      return next;
    });
  }, []);

  const patchSurface = useCallback((id: string, patch: Partial<SurfaceState>) => {
    setSurfaces((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  const appendLog = useCallback((id: string, line: SurfaceLogLine) => {
    setLogs((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), line] }));
  }, []);

  const markLastObservation = useCallback((id: string, ok: boolean, summary: string) => {
    setLogs((prev) => {
      const list = prev[id] ?? [];
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].status === 'running') {
          const updated = [...list];
          updated[i] = { ...updated[i], status: ok ? 'ok' : 'fail', summary: summary || updated[i].summary };
          return { ...prev, [id]: updated };
        }
      }
      return prev;
    });
  }, []);

  // Subscribe once to the live event stream and reduce events into state.
  useEffect(() => {
    const unsubscribe = workspaceClient.onEvent((event: WorkspaceEvent) => {
      if (!aliveRef.current) return;
      switch (event.type) {
        case 'surface-created':
          upsertSurface(event.surface);
          break;
        case 'surface-status':
          patchSurface(event.id, { status: event.status as SurfaceStatus });
          break;
        case 'surface-step':
          appendLog(event.id, { id: nextLineId(), tool: event.tool, summary: event.summary, status: 'running' });
          break;
        case 'surface-observation':
          markLastObservation(event.id, event.ok, event.summary);
          break;
        case 'surface-final':
          patchSurface(event.id, { answer: event.answer });
          break;
        case 'surface-error':
          patchSurface(event.id, { error: event.message });
          break;
        case 'run-complete':
          setStatus(event.ok ? 'done' : 'error');
          break;
      }
    });
    return unsubscribe;
  }, [upsertSurface, patchSurface, appendLog, markLastObservation]);

  const start = useCallback(async (specs: SurfaceSpec[]) => {
    if (specs.length === 0) return;
    const runId = newRunId();
    runIdRef.current = runId;
    setSurfaces([]);
    setLogs({});
    setError(null);
    setStatus('running');
    try {
      await workspaceClient.run({ runId, surfaces: specs });
      if (aliveRef.current) setStatus((cur) => (cur === 'running' ? 'done' : cur));
    } catch (e) {
      if (aliveRef.current) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      }
    } finally {
      if (runIdRef.current === runId) runIdRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    const runId = runIdRef.current;
    if (!runId) return;
    void workspaceClient.cancel({ runId }).catch(() => {});
  }, []);

  const orderedSurfaces = useMemo(() => surfaces, [surfaces]);

  return { surfaces: orderedSurfaces, logs, status, error, start, cancel };
}
