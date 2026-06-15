/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * State hook for the Terminal page.
 *
 * Loads the initial session + system-process + schedule snapshots through
 * {@link terminalClient}, then keeps them live via the bridge's push streams
 * (`sessions-changed` / `schedules-changed`). All session output is buffered
 * here per-session so switching tabs replays recent output instead of showing a
 * blank pane (the Main-process manager also keeps scrollback for cold attaches).
 *
 * Degrades gracefully: when the bridge is not wired the first call times out and
 * the status becomes `unavailable`, so the page shows a friendly notice with a
 * Retry button rather than hanging.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SystemTerminalProcess, TerminalSchedule, TerminalSession } from '@process/terminal/terminalTypes';
import type { CreateTerminalOptions } from '@process/terminal/terminalTypes';
import type { SaveScheduleRequest } from '@process/terminal/terminalBridge';
import type { ShellProfile } from '@process/terminal/shellProfiles';
import { terminalClient } from './terminalBridgeClient';
import { type TerminalBridgeStatus } from './constants';

/** The live state surfaced to the Terminal page. */
export type TerminalState = {
  status: TerminalBridgeStatus;
  sessions: TerminalSession[];
  runningCount: number;
  systemProcesses: SystemTerminalProcess[];
  schedules: TerminalSchedule[];
  /** Pickable shell profiles (VS Code-style "open a specific shell"). */
  shellProfiles: ShellProfile[];
  activeId: string | null;
  /** Accumulated output buffer per session id (raw, ANSI-bearing). */
  buffers: Record<string, string>;
  setActiveId: (id: string | null) => void;
  createSession: (options?: CreateTerminalOptions) => Promise<TerminalSession | null>;
  writeSession: (id: string, data: string) => void;
  resizeSession: (id: string, cols: number, rows: number) => void;
  killSession: (id: string) => void;
  removeSession: (id: string) => void;
  refreshSystem: () => Promise<void>;
  saveSchedule: (req: SaveScheduleRequest) => Promise<boolean>;
  removeSchedule: (id: string) => Promise<void>;
  runScheduleNow: (id: string) => Promise<void>;
  retry: () => void;
};

/** Max characters retained per session buffer in the renderer (matches Main scrollback). */
const RENDERER_BUFFER_LIMIT = 200_000;

const appendBounded = (prev: string, chunk: string): string => {
  const next = prev + chunk;
  return next.length > RENDERER_BUFFER_LIMIT ? next.slice(next.length - RENDERER_BUFFER_LIMIT) : next;
};

export const useTerminalState = (): TerminalState => {
  const [status, setStatus] = useState<TerminalBridgeStatus>('loading');
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [runningCount, setRunningCount] = useState(0);
  const [systemProcesses, setSystemProcesses] = useState<SystemTerminalProcess[]>([]);
  const [schedules, setSchedules] = useState<TerminalSchedule[]>([]);
  const [shellProfiles, setShellProfiles] = useState<ShellProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [buffers, setBuffers] = useState<Record<string, string>>({});
  const [reloadToken, setReloadToken] = useState(0);

  /** Track which session ids we have already cold-loaded scrollback for. */
  const hydrated = useRef<Set<string>>(new Set());

  // Initial load + live subscriptions.
  useEffect(() => {
    let cancelled = false;

    const hydrateScrollback = async (id: string): Promise<void> => {
      if (hydrated.current.has(id)) return;
      hydrated.current.add(id);
      const res = await terminalClient.scrollback({ id }).catch((): null => null);
      if (cancelled || !res || !res.ok || !res.data) return;
      setBuffers((prev) => ({ ...prev, [id]: res.data }));
    };

    const load = async (): Promise<void> => {
      try {
        const listRes = await terminalClient.list();
        if (cancelled) return;
        if (!listRes.ok) {
          setStatus('unavailable');
          return;
        }
        setSessions(listRes.data.sessions);
        setRunningCount(listRes.data.runningCount);
        setStatus('ready');
        // Pick a sensible default active session (first running one).
        const firstRunning = listRes.data.sessions.find((s) => s.status === 'running') ?? listRes.data.sessions[0];
        if (firstRunning) {
          setActiveId((curr) => curr ?? firstRunning.id);
          void hydrateScrollback(firstRunning.id);
        }
        // Schedules + system processes are non-critical; load best-effort.
        const [schedRes, sysRes, shellsRes] = await Promise.all([
          terminalClient.listSchedules().catch((): null => null),
          terminalClient.listSystem().catch((): null => null),
          terminalClient.listShells().catch((): null => null),
        ]);
        if (cancelled) return;
        if (schedRes?.ok) setSchedules(schedRes.data);
        if (sysRes?.ok) setSystemProcesses(sysRes.data);
        if (shellsRes?.ok) setShellProfiles(shellsRes.data);
      } catch {
        if (!cancelled) setStatus('unavailable');
      }
    };

    void load();

    const offData = terminalClient.onData(({ id, data }) => {
      setBuffers((prev) => ({ ...prev, [id]: appendBounded(prev[id] ?? '', data) }));
    });
    const offSessions = terminalClient.onSessionsChanged((next) => {
      setSessions(next);
      setRunningCount(next.filter((s) => s.status === 'running').length);
    });
    const offSchedules = terminalClient.onSchedulesChanged((next) => {
      setSchedules(next);
    });

    return () => {
      cancelled = true;
      offData();
      offSessions();
      offSchedules();
    };
  }, [reloadToken]);

  const createSession = useCallback(async (options?: CreateTerminalOptions): Promise<TerminalSession | null> => {
    const res = await terminalClient.create({ options }).catch((): null => null);
    if (!res || !res.ok) return null;
    setActiveId(res.data.id);
    return res.data;
  }, []);

  const writeSession = useCallback((id: string, data: string): void => {
    void terminalClient.write({ id, data }).catch(() => {});
  }, []);

  const resizeSession = useCallback((id: string, cols: number, rows: number): void => {
    void terminalClient.resize({ id, cols, rows }).catch(() => {});
  }, []);

  const killSession = useCallback((id: string): void => {
    void terminalClient.kill({ id }).catch(() => {});
  }, []);

  const removeSession = useCallback((id: string): void => {
    void terminalClient.remove({ id }).catch(() => {});
    setBuffers((prev) => {
      const { [id]: _removed, ...rest } = prev;
      return rest;
    });
    hydrated.current.delete(id);
    setActiveId((curr) => (curr === id ? null : curr));
  }, []);

  const refreshSystem = useCallback(async (): Promise<void> => {
    const res = await terminalClient.listSystem().catch((): null => null);
    if (res?.ok) setSystemProcesses(res.data);
  }, []);

  const saveSchedule = useCallback(async (req: SaveScheduleRequest): Promise<boolean> => {
    const res = await terminalClient.saveSchedule(req).catch((): null => null);
    return Boolean(res?.ok);
  }, []);

  const removeSchedule = useCallback(async (id: string): Promise<void> => {
    await terminalClient.removeSchedule({ id }).catch(() => {});
  }, []);

  const runScheduleNow = useCallback(async (id: string): Promise<void> => {
    await terminalClient.runScheduleNow({ id }).catch(() => {});
  }, []);

  const retry = useCallback((): void => {
    setStatus('loading');
    hydrated.current.clear();
    setReloadToken((t) => t + 1);
  }, []);

  return {
    status,
    sessions,
    runningCount,
    systemProcesses,
    schedules,
    shellProfiles,
    activeId,
    buffers,
    setActiveId,
    createSession,
    writeSession,
    resizeSession,
    killSession,
    removeSession,
    refreshSystem,
    saveSchedule,
    removeSchedule,
    runScheduleNow,
    retry,
  };
};
