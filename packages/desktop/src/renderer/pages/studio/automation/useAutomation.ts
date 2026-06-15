/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useAutomation` — state + actions for the Automation Studio view.
 *
 * Owns the workflow list (loaded from the Main-process store), the selected
 * workflow, the live run log (streamed from the engine via the event channel),
 * and the running run id. CRUD + run/cancel proxy to {@link automationClient}.
 * Bridge failures surface as a `bridgeError` string rather than throwing, so the
 * view can render a friendly "service unavailable" notice.
 *
 * Renderer-only.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { automationClient, type RunEvent, type Workflow } from './automationClient';
import type { SaveWorkflowRequest } from '@process/automation/automationBridge';

/** Failure arm of the result envelope; cast target under the no-`strictNullChecks` tsconfig. */
type AutomationFailure = { ok: false; error: string };

/** A single rendered line in the run log. */
export type RunLogLine = {
  id: string;
  kind: 'info' | 'node-ok' | 'node-fail' | 'done' | 'failed';
  text: string;
  at: number;
};

/** Public shape returned by {@link useAutomation}. */
export type UseAutomation = {
  workflows: Workflow[];
  selectedId: string | null;
  selected: Workflow | null;
  loading: boolean;
  bridgeError: string | null;
  runningRunId: string | null;
  runLog: RunLogLine[];
  reload: () => Promise<void>;
  select: (id: string | null) => void;
  save: (workflow: SaveWorkflowRequest['workflow']) => Promise<Workflow | null>;
  remove: (id: string) => Promise<void>;
  run: (id: string) => Promise<void>;
  cancel: () => Promise<void>;
  clearLog: () => void;
};

let lineCounter = 0;
const nextLineId = (): string => `l${Date.now().toString(36)}-${(lineCounter++).toString(36)}`;

/** Manage the Automation view's workflows + run state. */
export const useAutomation = (): UseAutomation => {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [runningRunId, setRunningRunId] = useState<string | null>(null);
  const [runLog, setRunLog] = useState<RunLogLine[]>([]);
  const runningRef = useRef<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await automationClient.list();
      if (result.ok) {
        setWorkflows(result.data);
        setBridgeError(null);
      } else {
        setBridgeError((result as AutomationFailure).error);
      }
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Subscribe to the live run log once.
  useEffect(() => {
    const off = automationClient.onEvent((event: RunEvent) => {
      // Only render events for the run we started.
      if (runningRef.current && event.runId !== runningRef.current) return;
      setRunLog((prev) => [...prev, toLogLine(event, workflowName(event, prev))]);
      if (event.type === 'run-finish') {
        runningRef.current = null;
        setRunningRunId(null);
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = useCallback((id: string | null): void => setSelectedId(id), []);

  const save = useCallback(
    async (workflow: SaveWorkflowRequest['workflow']): Promise<Workflow | null> => {
      try {
        const result = await automationClient.save(workflow);
        if (!result.ok) {
          setBridgeError((result as AutomationFailure).error);
          return null;
        }
        await reload();
        setSelectedId(result.data.id);
        return result.data;
      } catch (error) {
        setBridgeError(error instanceof Error ? error.message : String(error));
        return null;
      }
    },
    [reload]
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      const result = await automationClient.remove(id).catch((): null => null);
      if (result && result.ok) {
        setWorkflows(result.data);
        if (selectedId === id) setSelectedId(null);
      }
    },
    [selectedId]
  );

  const run = useCallback(async (id: string): Promise<void> => {
    setRunLog([]);
    try {
      const result = await automationClient.run(id);
      if (!result.ok) {
        setBridgeError((result as AutomationFailure).error);
        return;
      }
      runningRef.current = result.data.runId;
      setRunningRunId(result.data.runId);
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const cancel = useCallback(async (): Promise<void> => {
    const runId = runningRef.current;
    if (!runId) return;
    await automationClient.cancel(runId).catch((): undefined => undefined);
    runningRef.current = null;
    setRunningRunId(null);
  }, []);

  const clearLog = useCallback((): void => setRunLog([]), []);

  const selected = workflows.find((w) => w.id === selectedId) ?? null;

  return {
    workflows,
    selectedId,
    selected,
    loading,
    bridgeError,
    runningRunId,
    runLog,
    reload,
    select,
    save,
    remove,
    run,
    cancel,
    clearLog,
  };
};

/** Resolve a node name for a node event (best-effort lookup not needed here). */
const workflowName = (event: RunEvent, _prev: RunLogLine[]): string => {
  if (event.type === 'node-start' || event.type === 'node-finish') {
    const named = event as { name?: string; nodeId: string };
    return named.name ?? named.nodeId;
  }
  return '';
};

/** Map a {@link RunEvent} to a renderable log line. */
const toLogLine = (event: RunEvent, name: string): RunLogLine => {
  switch (event.type) {
    case 'run-start':
      return { id: nextLineId(), kind: 'info', text: 'run.start', at: event.at };
    case 'node-start':
      return { id: nextLineId(), kind: 'info', text: `▶ ${name}`, at: event.at };
    case 'node-finish':
      return event.ok
        ? { id: nextLineId(), kind: 'node-ok', text: `✓ ${name}`, at: event.at }
        : { id: nextLineId(), kind: 'node-fail', text: `✗ ${name}: ${event.error ?? ''}`, at: event.at };
    case 'run-finish':
      return event.ok
        ? { id: nextLineId(), kind: 'done', text: 'run.done', at: event.at }
        : { id: nextLineId(), kind: 'failed', text: 'run.failed', at: event.at };
    default:
      return { id: nextLineId(), kind: 'info', text: '', at: Date.now() };
  }
};

export default useAutomation;
