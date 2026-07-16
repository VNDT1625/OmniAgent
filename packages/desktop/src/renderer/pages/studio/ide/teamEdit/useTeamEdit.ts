/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useTeamEdit` — the data spine for the IDE "Team" panel.
 *
 * It subscribes to the Main-process team-edit service's live snapshot push
 * (`ide.team-changed`), seeds an initial snapshot for the open folder, and
 * registers the human user as a participant so they show up in presence next to
 * the agents. The panel renders {@link TeamEditSnapshot} and offers manual
 * claim/release of a file lease.
 *
 * Renderer-only: talks to Main via {@link teamEditClient}.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { teamEditClient, type TeamEditSnapshot } from './teamEditClient';

/** Stable id the human user claims/releases under (distinct from any agent). */
export const USER_AGENT_ID = 'user';

/** Public shape returned by {@link useTeamEdit}. */
export type UseTeamEdit = {
  /** The live snapshot (participants + leases + activity), or null before load. */
  snapshot: TeamEditSnapshot | null;
  /** Whether the initial snapshot is still loading. */
  loading: boolean;
  /** Manually claim a file lease as the user. */
  claim: (relPath: string, intent?: string) => Promise<void>;
  /** Release a file lease the user holds. */
  release: (relPath: string) => Promise<void>;
  /** Re-fetch the snapshot (manual refresh). */
  refresh: () => Promise<void>;
};

/**
 * Drive the team-edit panel for one workspace folder.
 *
 * @param rootPath - Absolute open folder, or null when none is selected.
 * @param userLabel - Display label for the human user in presence.
 */
export const useTeamEdit = (rootPath: string | null, userLabel: string): UseTeamEdit => {
  const [snapshot, setSnapshot] = useState<TeamEditSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!rootPath) return;
    const res = await teamEditClient.snapshot(rootPath).catch((): null => null);
    if (res && res.ok && aliveRef.current) setSnapshot(res.data);
  }, [rootPath]);

  // Seed + subscribe whenever the folder changes. The user joins so they appear
  // in presence; the subscription keeps the panel live as agents claim/write.
  useEffect(() => {
    if (!rootPath) {
      setSnapshot(null);
      return;
    }
    setLoading(true);
    let cancelled = false;
    void (async () => {
      await teamEditClient.join(rootPath, USER_AGENT_ID, userLabel).catch((): null => null);
      const res = await teamEditClient.snapshot(rootPath).catch((): null => null);
      if (!cancelled && aliveRef.current) {
        if (res && res.ok) setSnapshot(res.data);
        setLoading(false);
      }
    })();
    const unsubscribe = teamEditClient.onChanged((next) => {
      // Only react to the folder this panel is showing.
      if (!cancelled && aliveRef.current && next.rootPath === rootPath) setSnapshot(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [rootPath, userLabel]);

  const claim = useCallback(
    async (relPath: string, intent?: string): Promise<void> => {
      if (!rootPath) return;
      await teamEditClient.claim(rootPath, USER_AGENT_ID, relPath, intent).catch((): null => null);
      await refresh();
    },
    [rootPath, refresh]
  );

  const release = useCallback(
    async (relPath: string): Promise<void> => {
      if (!rootPath) return;
      await teamEditClient.release(rootPath, USER_AGENT_ID, relPath).catch((): null => null);
      await refresh();
    },
    [rootPath, refresh]
  );

  return useMemo(() => ({ snapshot, loading, claim, release, refresh }), [snapshot, loading, claim, release, refresh]);
};

export default useTeamEdit;
