/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useTestingState` — loads the test-session list + the selected session's
 * report via the testing client, and submits new runs. Degrades gracefully to a
 * friendly "bridge unavailable" state when the Main-process bridge is not
 * reachable. Renderer-only.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  testingClient,
  type AppUnderTest,
  type DetectAppRequest,
  type DetectProgress,
  type GenerateProgress,
  type GenerateTestRequest,
  type RunTestRequest,
  type RunTestResult,
  type TestingReport,
  type TestingSessionSummary,
} from './testingBridgeClient';
import { consumeRequestedSession } from './constants';

/** Status of an async load. */
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

/** The state surface returned by {@link useTestingState}. */
export type TestingState = {
  /** All known sessions (newest first). */
  sessions: TestingSessionSummary[];
  /** Status of the session-list load. */
  sessionsStatus: LoadStatus;
  /** The currently-selected session id. */
  selectedId?: string;
  /** The report for the selected session. */
  report?: TestingReport;
  /** Whether a run is currently in flight. */
  running: boolean;
  /** Select a session and load its report. */
  select: (sessionId: string) => void;
  /** Reload the session list (e.g. retry after the bridge comes online). */
  refresh: () => void;
  /** Submit a scenario, run it, then refresh + select it. Resolves with the result. */
  run: (request: RunTestRequest) => Promise<RunTestResult>;
  /** Generate an editable scenario draft from a plain-language description. */
  generate: (request: GenerateTestRequest) => Promise<{ name: string; steps: { id: string; description: string }[] }>;
  /** Read a project folder and propose how to run it (services + app + url). */
  detectApp: (request: DetectAppRequest) => Promise<AppUnderTest>;
  /** The latest app-detection progress update, or undefined when idle. */
  detectProgress?: DetectProgress;
  /** The latest scenario-generation progress update, or undefined when idle. */
  generateProgress?: GenerateProgress;
};

/**
 * Manage the testing page state against the (possibly-unwired) testing client.
 */
export const useTestingState = (): TestingState => {
  const [sessions, setSessions] = useState<TestingSessionSummary[]>([]);
  const [sessionsStatus, setSessionsStatus] = useState<LoadStatus>('idle');
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [report, setReport] = useState<TestingReport | undefined>(undefined);
  const [running, setRunning] = useState(false);
  // Live app-detection progress (Main → renderer). Cleared when a run finishes.
  const [detectProgress, setDetectProgress] = useState<DetectProgress | undefined>(undefined);
  // Live scenario-generation progress (Main → renderer). Auto-cleared after a
  // terminal phase so the bar doesn't linger.
  const [generateProgress, setGenerateProgress] = useState<GenerateProgress | undefined>(undefined);
  // A session id the Quick Active dock asked us to focus on mount (consumed once).
  const requestedSessionRef = useRef<string | null>(consumeRequestedSession());

  // Subscribe once to live detection progress so the page can show a status bar.
  useEffect(() => {
    const off = testingClient.onDetectProgress((progress) => {
      setDetectProgress(progress);
      // Auto-clear shortly after a terminal phase so the bar doesn't linger.
      if (progress.phase === 'done' || progress.phase === 'error') {
        setTimeout(() => setDetectProgress((cur) => (cur === progress ? undefined : cur)), 1500);
      }
    });
    return off;
  }, []);

  // Subscribe once to live generation progress (preparing → thinking → parsing).
  useEffect(() => {
    const off = testingClient.onGenerateProgress((progress) => {
      setGenerateProgress(progress);
      if (progress.phase === 'done' || progress.phase === 'error') {
        setTimeout(() => setGenerateProgress((cur) => (cur === progress ? undefined : cur)), 1500);
      }
    });
    return off;
  }, []);

  const loadReport = useCallback((sessionId: string) => {
    testingClient
      .getReport(sessionId)
      .then((r) => setReport(r))
      .catch(() => setReport(undefined));
  }, []);

  const refresh = useCallback(() => {
    setSessionsStatus('loading');
    testingClient
      .listSessions()
      .then((list) => {
        setSessions(list);
        setSessionsStatus('ready');
        // Honour a Quick Active hand-off: focus the requested session if present.
        const requested = requestedSessionRef.current;
        if (requested) {
          requestedSessionRef.current = null;
          if (list.some((s) => s.sessionId === requested)) {
            setSelectedId(requested);
            setReport(undefined);
            loadReport(requested);
          }
        }
      })
      .catch(() => {
        setSessions([]);
        setSessionsStatus('unavailable');
      });
  }, [loadReport]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const select = useCallback(
    (sessionId: string) => {
      setSelectedId(sessionId);
      setReport(undefined);
      loadReport(sessionId);
    },
    [loadReport]
  );

  const run = useCallback(
    async (request: RunTestRequest): Promise<RunTestResult> => {
      setRunning(true);
      try {
        const result = await testingClient.run(request);
        refresh();
        setSelectedId(result.sessionId);
        setReport(undefined);
        loadReport(result.sessionId);
        return result;
      } finally {
        setRunning(false);
      }
    },
    [refresh, loadReport]
  );

  const generate = useCallback((request: GenerateTestRequest) => testingClient.generate(request), []);

  const detectApp = useCallback((request: DetectAppRequest) => testingClient.detectApp(request), []);

  return {
    sessions,
    sessionsStatus,
    selectedId,
    report,
    running,
    select,
    refresh,
    run,
    generate,
    detectApp,
    detectProgress,
    generateProgress,
  };
};
