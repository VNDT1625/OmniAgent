/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * State hook for the Personal Manager page.
 *
 * Loads the {@link ManagerData} document once on mount, subscribes to the
 * `dataChanged` push so the UI stays in sync (including agent-side edits via the
 * Manager MCP server), and exposes thin action wrappers around
 * {@link managerClient}. Each mutating action applies the freshly-returned
 * document immediately (the bridge returns it on success), so the UI updates
 * without waiting for the broadcast.
 *
 * When the bridge is not wired yet (Main-process bootstrap pending) the initial
 * load times out and `status` becomes `'unavailable'`, which the page renders as
 * a friendly "not ready" notice with a Retry button.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ManagerData } from '@process/manager/managerTypes';
import type { ManagerResult } from '@process/manager/managerBridge';
import { emptyManagerData } from '@process/manager/managerTypes';
import { managerClient } from './managerBridgeClient';

/** Load status of the Manager document. */
export type ManagerStatus = 'loading' | 'ready' | 'unavailable';

/** Unwrap a {@link ManagerResult}, applying it when ok. Returns ok flag. */
type ApplyResult = (result: ManagerResult<ManagerData>) => boolean;

export type UseManagerStore = {
  data: ManagerData;
  status: ManagerStatus;
  reload: () => void;
  /** The bound client for AI + reminder actions that don't return ManagerData directly. */
  client: typeof managerClient;
  /** Run a mutating client call and apply the returned document. */
  run: (call: () => Promise<ManagerResult<ManagerData>>) => Promise<boolean>;
  /**
   * Like {@link run}, but resolves with the freshly-applied document (or `null`
   * on failure). Used by flows that need the new record — e.g. create-then-open
   * a note in the full-page editor.
   */
  mutate: (call: () => Promise<ManagerResult<ManagerData>>) => Promise<ManagerData | null>;
};

/**
 * Manage the Manager page state. The `run` helper centralises the
 * envelope-unwrap + optimistic-apply pattern so each view can call e.g.
 * `run(() => client.addTask({ input }))` and have the UI update on success.
 */
export function useManagerStore(): UseManagerStore {
  const [data, setData] = useState<ManagerData>(() => emptyManagerData());
  const [status, setStatus] = useState<ManagerStatus>('loading');
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const apply: ApplyResult = useCallback((result) => {
    if (result && result.ok) {
      if (aliveRef.current) setData(result.data);
      return true;
    }
    return false;
  }, []);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const result = await managerClient.getData();
      if (!aliveRef.current) return;
      if (result && result.ok) {
        setData(result.data);
        setStatus('ready');
      } else {
        setStatus('unavailable');
      }
    } catch {
      if (aliveRef.current) setStatus('unavailable');
    }
  }, []);

  // Initial load.
  useEffect(() => {
    void load();
  }, [load]);

  // Live updates from the Main process (and agent-side edits).
  useEffect(() => {
    const off = managerClient.onDataChanged((next) => {
      if (aliveRef.current) setData(next);
    });
    return off;
  }, []);

  const run = useCallback(
    async (call: () => Promise<ManagerResult<ManagerData>>): Promise<boolean> => {
      try {
        const result = await call();
        return apply(result);
      } catch {
        return false;
      }
    },
    [apply]
  );

  const mutate = useCallback(async (call: () => Promise<ManagerResult<ManagerData>>): Promise<ManagerData | null> => {
    try {
      const result = await call();
      if (result && result.ok) {
        if (aliveRef.current) setData(result.data);
        return result.data;
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  return { data, status, reload: () => void load(), client: managerClient, run, mutate };
}
