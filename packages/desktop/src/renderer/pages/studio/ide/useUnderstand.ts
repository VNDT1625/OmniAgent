/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useUnderstand` — state + actions for the IDE "Understand Anything" mode (an
 * in-app adaptation of github.com/Lum1104/Understand-Anything, MIT).
 *
 * Building the knowledge graph is a user-triggered Main-process job that fuses
 * a deterministic structural pass with a semantic LLM pass and persists the
 * result per-repo. This hook orchestrates the two ways the renderer touches
 * that state:
 *
 *  - {@link UseUnderstand.loadExisting} loads a previously-built graph (fast,
 *    no model) so a repo the user already explored shows instantly,
 *  - {@link UseUnderstand.build} runs a fresh build: it subscribes to the
 *    phase-progress stream, calls `kgBuild`, and on success records the elapsed
 *    duration so {@link GenerationProgress}'s ETA improves next time, and
 *  - Live mode only watches repo changes and marks the current graph stale; it
 *    never starts semantic model work by itself.
 *
 * A monotonically increasing run token guards against a stale build: when a new
 * build (or a `rootPath` change) supersedes an in-flight one, the older run's
 * phase events and resolution are ignored. An unmount flag prevents setting
 * state after the component is gone. Renderer-only: talks to Main exclusively
 * via {@link ideClient}.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ideClient, type KnowledgeBuildPhase, type KnowledgeGraph } from './ideClient';
import { recordGenDuration } from '../components/GenerationProgress';

/** Lifecycle of the Understand mode. */
export type UnderstandStatus = 'idle' | 'loading' | 'building' | 'ready' | 'error';

/** Build-failure reason code (mirrors {@link UnderstandResult}'s code). */
export type UnderstandErrorCode = 'no-model' | 'error';

export type UnderstandBuildEvent = {
  phase: KnowledgeBuildPhase;
  detail: string;
  at: number;
};

/** Public shape returned by {@link useUnderstand}. */
export type UseUnderstand = {
  /** The loaded/built knowledge graph, or null when none exists yet. */
  graph: KnowledgeGraph | null;
  /** Coarse lifecycle status driving the panel's body. */
  status: UnderstandStatus;
  /** Current build phase (for the progress label). */
  phase: KnowledgeBuildPhase;
  /** Optional human detail for the current phase (e.g. the file being parsed). */
  phaseDetail: string;
  /** Ordered phase events from the current build, used for an honest timeline. */
  buildEvents: UnderstandBuildEvent[];
  /** Failure message when `status === 'error'`, else null. */
  error: string | null;
  /** Failure reason code when `status === 'error'`, else null. */
  errorCode: UnderstandErrorCode | null;
  /** Whether Live mode (realtime stale/change watch, no automatic model work) is on. */
  live: boolean;
  /** File ids changed in the most recent live update (for diff-impact highlight). */
  changedFiles: string[];
  /** Load a previously-built graph for the current `rootPath` (no model call). */
  loadExisting: () => Promise<void>;
  /** Build (and persist) the knowledge graph for `rootPath` using `model`. */
  build: (model: string, language?: string, forceFresh?: boolean) => Promise<void>;
  /** Toggle Live mode. Turning on starts the watcher but never starts a semantic build. */
  setLive: (on: boolean, model: string | null, language?: string) => void;
  /** Clear the current diff-impact highlight. */
  clearChanged: () => void;
};

/** The operation key under which build durations are learned for the ETA. */
const KG_OP_KEY = 'ide.kg';

/** Normalise any thrown value into the shared failure envelope. */
const toFailure = (e: unknown): { ok: false; error: string; code: UnderstandErrorCode } => ({
  ok: false,
  error: e instanceof Error ? e.message : String(e),
  code: 'error',
});

const toBuildEvents = (
  events: Array<{ phase: KnowledgeBuildPhase; detail?: string; at: number }>
): UnderstandBuildEvent[] => events.map((event) => ({ phase: event.phase, detail: event.detail ?? '', at: event.at }));

const freshnessFiles = (freshness?: {
  changed: string[];
  removed: string[];
  added: string[];
  markerChanged?: string[];
}): string[] =>
  freshness
    ? Array.from(
        new Set([...freshness.changed, ...freshness.removed, ...freshness.added, ...(freshness.markerChanged ?? [])])
      )
    : [];

export const useUnderstand = (rootPath: string | null): UseUnderstand => {
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [status, setStatus] = useState<UnderstandStatus>('idle');
  const [phase, setPhase] = useState<KnowledgeBuildPhase>('idle');
  const [phaseDetail, setPhaseDetail] = useState('');
  const [buildEvents, setBuildEvents] = useState<UnderstandBuildEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<UnderstandErrorCode | null>(null);
  const [live, setLiveState] = useState(false);
  const [changedFiles, setChangedFiles] = useState<string[]>([]);

  // Unmount guard + run token (any new run/rootPath change bumps it).
  const mountedRef = useRef(true);
  const runRef = useRef(0);
  // Live-mode bookkeeping is retained for API compatibility; Main intentionally
  // ignores model/language so watching never spends model tokens.
  const liveModelRef = useRef<string | null>(null);
  const liveLangRef = useRef<string | null>(null);
  const eventUnsubscribeRef = useRef<(() => void) | null>(null);

  const appendBuildEvent = useCallback((event: Omit<UnderstandBuildEvent, 'at'>): void => {
    setBuildEvents((current) => {
      const last = current.at(-1);
      if (last?.phase === event.phase && last.detail === event.detail) {
        return current;
      }
      return current.concat({ ...event, at: Date.now() });
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      eventUnsubscribeRef.current?.();
      eventUnsubscribeRef.current = null;
    };
  }, [rootPath]);

  const attachBuildEvents = useCallback(
    (token: number): void => {
      eventUnsubscribeRef.current?.();
      eventUnsubscribeRef.current = ideClient.onKgEvent((event) => {
        if (runRef.current !== token) return;
        if (event.rootPath && event.rootPath !== rootPath) return;
        setPhase(event.phase);
        const detail = event.detail ?? '';
        setPhaseDetail(detail);
        appendBuildEvent({ phase: event.phase, detail });
        if (event.phase === 'done') {
          void ideClient.kgGet(rootPath ?? '').then((result) => {
            if (!mountedRef.current || runRef.current !== token || !result.ok || !result.data) return;
            setGraph(result.data);
            setStatus('ready');
            setPhaseDetail('');
            setChangedFiles([]);
            eventUnsubscribeRef.current?.();
            eventUnsubscribeRef.current = null;
          });
        }
        if (event.phase === 'error') {
          setError(detail);
          setErrorCode('error');
          setStatus('error');
          eventUnsubscribeRef.current?.();
          eventUnsubscribeRef.current = null;
        }
      });
    },
    [appendBuildEvent, rootPath]
  );

  const loadExisting = useCallback(async (): Promise<void> => {
    // No folder picked: nothing to load — settle back to the empty state.
    if (!rootPath) {
      setGraph(null);
      setStatus('idle');
      setPhase('idle');
      setPhaseDetail('');
      setBuildEvents([]);
      setError(null);
      setErrorCode(null);
      setChangedFiles([]);
      return;
    }
    const token = ++runRef.current;
    setStatus('loading');
    setError(null);
    setErrorCode(null);
    const active = await ideClient.kgStatus(rootPath).catch(toFailure);
    if (!mountedRef.current || runRef.current !== token) return;
    if (active.ok && active.data.running) {
      setStatus('building');
      setPhase(active.data.phase);
      setPhaseDetail(active.data.detail ?? '');
      setBuildEvents(toBuildEvents(active.data.events));
      attachBuildEvents(token);
      return;
    }
    if (active.ok) {
      setChangedFiles(freshnessFiles(active.data.freshness));
    }
    const result = await ideClient.kgGet(rootPath).catch(toFailure);
    if (!mountedRef.current || runRef.current !== token) return;
    if (result.ok && result.data) {
      setGraph(result.data);
      setStatus('ready');
      setPhase('done');
      setBuildEvents([]);
      return;
    }
    // Either no graph persisted yet, or a soft read failure: invite a build.
    setGraph(null);
    setStatus('idle');
    setPhase('idle');
    setChangedFiles([]);
    setBuildEvents([]);
  }, [attachBuildEvents, rootPath]);

  const build = useCallback(
    async (model: string, language?: string, forceFresh = false): Promise<void> => {
      if (!rootPath) return;
      const token = ++runRef.current;
      setStatus('building');
      setPhase('scanning');
      setPhaseDetail('');
      setBuildEvents([{ phase: 'scanning', detail: '', at: Date.now() }]);
      setError(null);
      setErrorCode(null);

      attachBuildEvents(token);

      const startedAt = Date.now();
      try {
        const result = await ideClient.kgBuild(rootPath, model, language, forceFresh);
        if (!mountedRef.current || runRef.current !== token) return;
        if (result.ok) {
          recordGenDuration(KG_OP_KEY, Date.now() - startedAt);
          setGraph(result.data);
          setStatus('ready');
          setPhase('done');
          setPhaseDetail('');
          setChangedFiles([]);
          appendBuildEvent({ phase: 'done', detail: '' });
        } else {
          const failure = result as Extract<typeof result, { ok: false }>;
          setError(failure.error);
          setErrorCode(failure.code);
          setStatus('error');
          setPhase('error');
          appendBuildEvent({ phase: 'error', detail: failure.error });
        }
      } catch (e) {
        if (!mountedRef.current || runRef.current !== token) return;
        setError(e instanceof Error ? e.message : String(e));
        setErrorCode('error');
        setStatus('error');
        setPhase('error');
        appendBuildEvent({ phase: 'error', detail: e instanceof Error ? e.message : String(e) });
      } finally {
        eventUnsubscribeRef.current?.();
        eventUnsubscribeRef.current = null;
      }
    },
    [appendBuildEvent, attachBuildEvents, rootPath]
  );

  const clearChanged = useCallback((): void => setChangedFiles([]), []);

  // Live mode: subscribe to debounced repo-change batches. On each batch, record
  // changed files for stale/diff-impact UI only. Semantic summary is explicit
  // user work and must not start from a file watcher.
  useEffect(() => {
    if (!live || !rootPath) return undefined;
    const unsubscribe = ideClient.onKgChanged((event) => {
      if (!mountedRef.current || event.rootPath !== rootPath) return;
      const touched = [...event.changed, ...event.removed];
      if (touched.length > 0) setChangedFiles(touched);
      setError(null);
      setErrorCode(null);
    });
    return () => {
      unsubscribe();
    };
  }, [live, rootPath]);

  const setLive = useCallback(
    (on: boolean, model: string | null, language?: string): void => {
      liveModelRef.current = model;
      liveLangRef.current = language ?? null;
      setLiveState(on);
      if (!rootPath) return;
      if (on) {
        void ideClient.kgWatchStart(rootPath, model, language).catch(() => {});
      } else {
        void ideClient.kgWatchStop(rootPath).catch(() => {});
      }
    },
    [rootPath]
  );

  return {
    graph,
    status,
    phase,
    phaseDetail,
    buildEvents,
    error,
    errorCode,
    live,
    changedFiles,
    loadExisting,
    build,
    setLive,
    clearChanged,
  };
};

export default useUnderstand;
