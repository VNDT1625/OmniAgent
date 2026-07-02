/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useTeamCollab` — drives the team-collaboration control bar for one workspace.
 *
 * It tracks the local role in a team session:
 *  - `host`  — this machine published its open repo; peers connect to it.
 *  - `peer`  — this machine joined a remote host's repo (LAN ip:port or a tunnel
 *              URL). While a peer, the IDE workspace reads/writes through the
 *              host and the Understand/Wiki panels are read-only.
 *  - `none`  — not in a team session.
 *
 * The peer's live presence/leases come from polling the host's snapshot; the
 * host's come from the in-process service (the `Team` panel already subscribes
 * to that, so this hook only needs the peer polling).
 *
 * Renderer-only: talks to Main via {@link teamCollabClient}.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { teamCollabClient, type RemoteTeamSnapshot, type TeamPublishData } from './teamCollabClient';
import type { ISessionMcpServer } from '@/common/config/storage';

/** Local role within a team session. */
export type TeamRole = 'none' | 'host' | 'peer';

/** Peer connection coordinates (kept so every later call can reach the host). */
export type PeerConnection = {
  baseUrl: string;
  token: string;
  repoName: string;
  workspacePath: string;
  remoteMcpServer: ISessionMcpServer;
};

/** Public shape returned by {@link useTeamCollab}. */
export type UseTeamCollab = {
  /** Current role. */
  role: TeamRole;
  /** Host publish info (join code / URL), when hosting. */
  publishInfo: TeamPublishData | null;
  /** Peer connection coordinates, when a peer. */
  peer: PeerConnection | null;
  /** Latest remote snapshot (peer mode), or null. */
  remoteSnapshot: RemoteTeamSnapshot | null;
  /** Whether a publish/join call is in flight. */
  busy: boolean;
  /** Last error message (publish/join), or null. */
  error: string | null;
  /** HOST: publish the open repo (LAN by default; `online` opens a WAN tunnel). */
  publish: (password: string, online: boolean) => Promise<boolean>;
  /** HOST: stop sharing. */
  unpublish: () => Promise<void>;
  /** PEER: join a remote host by base URL + password. */
  join: (baseUrl: string, password: string, name: string) => Promise<boolean>;
  /** PEER: leave the session. */
  leave: () => Promise<void>;
};

/** Poll interval for the peer's remote snapshot (ms). */
const PEER_POLL_MS = 1500;

/**
 * Manage team-collaboration state for a workspace folder.
 *
 * @param rootPath - The host's open folder (used when publishing). Null disables hosting.
 */
export const useTeamCollab = (rootPath: string | null): UseTeamCollab => {
  const [role, setRole] = useState<TeamRole>('none');
  const [publishInfo, setPublishInfo] = useState<TeamPublishData | null>(null);
  const [peer, setPeer] = useState<PeerConnection | null>(null);
  const [remoteSnapshot, setRemoteSnapshot] = useState<RemoteTeamSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Reconcile host status when the folder opens (e.g. after a reload).
  useEffect(() => {
    let cancelled = false;
    void teamCollabClient
      .status()
      .then((res) => {
        if (cancelled || !aliveRef.current) return;
        if (res.ok && res.data.publishing && res.data.info) {
          setRole('host');
          setPublishInfo(res.data.info);
        }
      })
      .catch((): undefined => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Peer snapshot polling.
  useEffect(() => {
    if (role !== 'peer' || !peer) return;
    let stopped = false;
    const tick = async (): Promise<void> => {
      const res = await teamCollabClient.remoteSnapshot(peer.baseUrl, peer.token).catch((): null => null);
      if (stopped || !aliveRef.current) return;
      if (res && res.ok) setRemoteSnapshot(res.data);
    };
    void tick();
    const timer = setInterval(() => void tick(), PEER_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [role, peer]);

  const publish = useCallback(
    async (password: string, online: boolean): Promise<boolean> => {
      if (!rootPath || busy) return false;
      setBusy(true);
      setError(null);
      try {
        const res = await teamCollabClient.publish(rootPath, password, online);
        if (!aliveRef.current) return res.ok;
        if (res.ok === false) {
          setError(res.error);
          return false;
        }
        setRole('host');
        setPublishInfo(res.data);
        return true;
      } catch (e) {
        if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        if (aliveRef.current) setBusy(false);
      }
    },
    [busy, rootPath]
  );

  const unpublish = useCallback(async (): Promise<void> => {
    if (!rootPath) return;
    await teamCollabClient.unpublish(rootPath).catch((): undefined => undefined);
    if (!aliveRef.current) return;
    setRole('none');
    setPublishInfo(null);
  }, [rootPath]);

  const join = useCallback(
    async (baseUrl: string, password: string, name: string): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      setError(null);
      try {
        const res = await teamCollabClient.join(baseUrl, password, name);
        if (!aliveRef.current) return res.ok;
        if (res.ok === false) {
          setError(res.error);
          return false;
        }
        setRole('peer');
        setPeer({
          baseUrl: res.data.baseUrl,
          token: res.data.peerToken,
          repoName: res.data.repoName,
          workspacePath: res.data.workspacePath,
          remoteMcpServer: res.data.remoteMcpServer,
        });
        return true;
      } catch (e) {
        if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        if (aliveRef.current) setBusy(false);
      }
    },
    [busy]
  );

  const leave = useCallback(async (): Promise<void> => {
    if (peer) await teamCollabClient.leave(peer.baseUrl, peer.token).catch((): undefined => undefined);
    if (!aliveRef.current) return;
    setRole('none');
    setPeer(null);
    setRemoteSnapshot(null);
  }, [peer]);

  return useMemo(
    () => ({ role, publishInfo, peer, remoteSnapshot, busy, error, publish, unpublish, join, leave }),
    [role, publishInfo, peer, remoteSnapshot, busy, error, publish, unpublish, join, leave]
  );
};

export default useTeamCollab;
