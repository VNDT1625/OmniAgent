/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useIdeMemory` — renderer hook that surfaces ONE IDE chat tab's ephemeral
 * session super-memory for the UI.
 *
 * The agent writes to the memory through the IDE MCP `ide_memory_*` tools; this
 * hook only READS a snapshot (notes, token usage, dedup/compaction/recall
 * counters, secret KEY names — never values) over the `ide.memory-snapshot`
 * bridge, and exposes a `clear()` that drops the whole session (`ide.memory-clear`).
 *
 * It polls while `enabled` (the drawer is open) so the user watches the agent's
 * memory grow live, and stops polling when closed to avoid idle IPC churn.
 *
 * Renderer-only: no Node.js APIs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ideClient, type IdeMemoryRecordableKind, type SuperMemorySnapshot } from '../ideClient';

/** Poll interval (ms) while the memory view is open. */
const POLL_MS = 3000;

/** What {@link useIdeMemory} returns. */
export type UseIdeMemory = {
  /** Latest snapshot, or null when no session / not yet loaded. */
  snapshot: SuperMemorySnapshot | null;
  /** Whether a fetch is currently in flight. */
  loading: boolean;
  /** Force an immediate refresh. */
  refresh: () => Promise<void>;
  /** Clear the whole session memory, then refresh. */
  clear: () => Promise<void>;
  /** Manually jot a note (user-facing equivalent of the agent's ide_memory_remember). Returns an error string on failure, or null on success, then refreshes. */
  remember: (text: string, opts?: { kind?: IdeMemoryRecordableKind; pinned?: boolean }) => Promise<string | null>;
};

/**
 * Track and control one session's memory.
 *
 * @param memId  The session-memory id of the active chat tab, or null.
 * @param enabled Poll only while true (e.g. the drawer is open).
 */
export const useIdeMemory = (memId: string | null, enabled: boolean): UseIdeMemory => {
  const [snapshot, setSnapshot] = useState<SuperMemorySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!memId) {
      setSnapshot(null);
      return;
    }
    setLoading(true);
    try {
      const res = await ideClient.memorySnapshot(memId).catch((): null => null);
      if (!aliveRef.current) return;
      setSnapshot(res?.ok ? res.data : null);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [memId]);

  const clear = useCallback(async (): Promise<void> => {
    if (!memId) return;
    await ideClient.memoryClear(memId).catch((): undefined => undefined);
    await refresh();
  }, [memId, refresh]);

  const remember = useCallback(
    async (text: string, opts?: { kind?: IdeMemoryRecordableKind; pinned?: boolean }): Promise<string | null> => {
      if (!memId) return 'No active session.';
      const trimmed = text.trim();
      if (!trimmed) return 'Note is empty.';
      const res = await ideClient.memoryRemember(memId, trimmed, opts).catch((error): { ok: false; error: string } => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
      if (res.ok === false) return res.error;
      await refresh();
      return null;
    },
    [memId, refresh]
  );

  useEffect(() => {
    if (!enabled || !memId) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, memId, refresh]);

  return { snapshot, loading, refresh, clear, remember };
};

export default useIdeMemory;
