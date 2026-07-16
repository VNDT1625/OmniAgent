/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/** React state controller for one cloud-authoritative IDE workspace session. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CloudWorkspaceManifest, CloudWorkspaceSyncState } from '@/common/adapter/cloudWorkspaceMapper';
import {
  cloudWorkspaceClient,
  type CloudWorkspacePublishProgress,
  type CloudWorkspacePullProgress,
  type CloudWorkspaceSessionData,
} from './cloudWorkspaceClient';
import type { PeerConnection } from '../useTeamCollab';
import type { ReplicaConflictResolution, ReplicaSyncStatus } from '@process/ide/teamEdit/cloud/cloudReplicaTypes';

export type CloudWorkspaceConnection = Omit<PeerConnection, 'peerCapabilities'> & {
  relayBaseUrl: string;
  workspaceId: string;
  cachePath?: string;
};

export type UseCloudWorkspace = {
  connected: boolean;
  session: CloudWorkspaceConnection | null;
  manifest: CloudWorkspaceManifest | null;
  state: CloudWorkspaceSyncState | null;
  replica: ReplicaSyncStatus | null;
  busy: boolean;
  publishing: boolean;
  pulling: boolean;
  publishProgress: CloudWorkspacePublishProgress | null;
  pullProgress: CloudWorkspacePullProgress | null;
  error: string | null;
  connect: (
    relayBaseUrl: string,
    workspaceId: string,
    token: string,
    displayName?: string,
    localRootPath?: string
  ) => Promise<boolean>;
  disconnect: () => Promise<void>;
  publishLocal: (rootPath: string) => Promise<boolean>;
  pullCloud: (rootPath: string) => Promise<boolean>;
  claimFile: (relPath: string, intent?: string) => Promise<boolean>;
  releaseFile: (relPath: string) => Promise<void>;
  refreshStatus: () => Promise<void>;
  syncNow: () => Promise<boolean>;
  resolveConflict: (
    conflictId: string,
    resolution: ReplicaConflictResolution,
    mergedContent?: string
  ) => Promise<boolean>;
};

const toConnection = (data: CloudWorkspaceSessionData): CloudWorkspaceConnection => ({
  baseUrl: data.config.relayBaseUrl,
  token: data.config.token,
  repoName: data.config.workspaceId,
  workspacePath: data.workspacePath,
  cachePath: data.cachePath,
  remoteMcpServer: data.remoteMcpServer,
  relayBaseUrl: data.config.relayBaseUrl,
  workspaceId: data.config.workspaceId,
});

export const useCloudWorkspace = (): UseCloudWorkspace => {
  const [session, setSession] = useState<CloudWorkspaceConnection | null>(null);
  const [manifest, setManifest] = useState<CloudWorkspaceManifest | null>(null);
  const [state, setState] = useState<CloudWorkspaceSyncState | null>(null);
  const [replica, setReplica] = useState<ReplicaSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [publishProgress, setPublishProgress] = useState<CloudWorkspacePublishProgress | null>(null);
  const [pullProgress, setPullProgress] = useState<CloudWorkspacePullProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  const applyStatus = useCallback((data: Awaited<ReturnType<typeof cloudWorkspaceClient.status>>): void => {
    if (!aliveRef.current || data.ok === false) return;
    if (!data.data.connected || !data.data.config || !data.data.workspacePath || !data.data.remoteMcpServer) {
      setSession(null);
      setManifest(null);
      setState(null);
      setReplica(null);
      return;
    }
    setSession({
      baseUrl: data.data.config.relayBaseUrl,
      token: data.data.config.token,
      repoName: data.data.config.workspaceId,
      workspacePath: data.data.workspacePath,
      cachePath: data.data.cachePath,
      remoteMcpServer: data.data.remoteMcpServer,
      relayBaseUrl: data.data.config.relayBaseUrl,
      workspaceId: data.data.config.workspaceId,
    });
    setManifest(data.data.manifest ?? null);
    setState(data.data.state ?? null);
    setReplica(data.data.replica ?? null);
  }, []);

  const refreshStatus = useCallback(async (): Promise<void> => {
    const res = await cloudWorkspaceClient.status(session?.workspaceId).catch((): null => null);
    if (res) applyStatus(res);
  }, [applyStatus, session?.workspaceId]);

  const scheduleRefresh = useCallback((): void => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshStatus();
    }, 120);
  }, [refreshStatus]);

  useEffect(() => {
    void cloudWorkspaceClient
      .status()
      .then(applyStatus)
      .catch((): undefined => undefined);
  }, [applyStatus]);

  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => void refreshStatus(), 1500);
    return () => clearInterval(timer);
  }, [refreshStatus, session]);

  useEffect(() => {
    if (!session) return;
    return cloudWorkspaceClient.onEvent((event) => {
      if (event.workspaceId !== session.workspaceId || !aliveRef.current) return;
      if (event.kind === 'operation') {
        setManifest(event.manifest);
        scheduleRefresh();
        return;
      }
      if (event.kind === 'state') {
        setState(event.state);
        if (event.manifest) setManifest(event.manifest);
        return;
      }
      if (event.kind === 'replica') {
        setReplica(event.replica);
        return;
      }

      if (event.kind === 'error') {
        setError(event.error);
      }
    });
  }, [scheduleRefresh, session]);

  const connect = useCallback(
    async (
      relayBaseUrl: string,
      workspaceId: string,
      token: string,
      displayName?: string,
      localRootPath?: string
    ): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      setError(null);
      try {
        const res = await cloudWorkspaceClient.connect({
          relayBaseUrl,
          workspaceId,
          token,
          displayName,
          localRootPath,
        });
        if (!aliveRef.current) return res.ok;
        if (res.ok === false) {
          setError(res.error);
          return false;
        }
        setSession(toConnection(res.data));
        setManifest(res.data.manifest);
        setState(res.data.state);
        setReplica(res.data.replica ?? null);
        return true;
      } catch (err) {
        if (aliveRef.current) setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        if (aliveRef.current) setBusy(false);
      }
    },
    [busy]
  );

  const disconnect = useCallback(async (): Promise<void> => {
    const current = session;
    if (current) await cloudWorkspaceClient.disconnect(current.workspaceId).catch((): undefined => undefined);
    if (!aliveRef.current) return;
    setSession(null);
    setManifest(null);
    setState(null);
    setReplica(null);
  }, [session]);

  const publishLocal = useCallback(
    async (rootPath: string): Promise<boolean> => {
      if (!session || publishing) return false;
      setPublishing(true);
      setPublishProgress(null);
      setError(null);
      try {
        const res = await cloudWorkspaceClient.publish(session.workspaceId, rootPath);
        if (res.ok === false) {
          setError(res.error);
          setPublishing(false);
          return false;
        }
        setPublishProgress(res.data);
        if (!res.data.running) setPublishing(false);
        return true;
      } catch (err) {
        if (aliveRef.current)
          setError(
            err instanceof Error ? err.message : 'Cloud publish did not receive a response from the main process.'
          );
        setPublishing(false);
        return false;
      }
    },
    [publishing, session]
  );

  const pullCloud = useCallback(
    async (rootPath: string): Promise<boolean> => {
      if (!session || pulling) return false;
      setPulling(true);
      setPullProgress(null);
      setError(null);
      try {
        const res = await cloudWorkspaceClient.pull(session.workspaceId, rootPath);
        if (res.ok === false) {
          setError(res.error);
          setPulling(false);
          return false;
        }
        setPullProgress(res.data);
        if (!res.data.running) setPulling(false);
        return true;
      } catch (err) {
        if (aliveRef.current) setError(err instanceof Error ? err.message : 'Cloud pull did not receive a response.');
        setPulling(false);
        return false;
      }
    },
    [pulling, session]
  );

  const claimFile = useCallback(
    async (relPath: string, intent?: string): Promise<boolean> => {
      if (!session) return false;
      const res = await cloudWorkspaceClient.claim(session.workspaceId, relPath, intent).catch((err): null => {
        if (aliveRef.current) setError(err instanceof Error ? err.message : String(err));
        return null;
      });
      if (!res) return false;
      if (res.ok === false) {
        setError(res.error);
        return false;
      }
      if (res.data.ok === false) {
        setError(res.data.lease.name || res.data.lease.clientId);
        return false;
      }
      await refreshStatus();
      return true;
    },
    [refreshStatus, session]
  );

  const releaseFile = useCallback(
    async (relPath: string): Promise<void> => {
      if (!session) return;
      await cloudWorkspaceClient.release(session.workspaceId, relPath).catch((): null => null);
      await refreshStatus();
    },
    [refreshStatus, session]
  );

  const syncNow = useCallback(async (): Promise<boolean> => {
    if (!session) return false;
    const res = await cloudWorkspaceClient.replicaSync(session.workspaceId).catch((err): null => {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err));
      return null;
    });
    if (!res) return false;
    if (res.ok === false) {
      setError(res.error);
      return false;
    }
    setReplica(res.data);
    return true;
  }, [session]);

  const resolveConflict = useCallback(
    async (conflictId: string, resolution: ReplicaConflictResolution, mergedContent?: string): Promise<boolean> => {
      if (!session) return false;
      const res = await cloudWorkspaceClient
        .replicaResolve(session.workspaceId, conflictId, resolution, mergedContent)
        .catch((err): null => {
          if (aliveRef.current) setError(err instanceof Error ? err.message : String(err));
          return null;
        });
      if (!res) return false;
      if (res.ok === false) {
        setError(res.error);
        return false;
      }
      setReplica(res.data);
      return true;
    },
    [session]
  );

  useEffect(() => {
    if (!session || !publishing) return;
    let disposed = false;
    const failPublishPoll = (message: string): void => {
      if (disposed || !aliveRef.current) return;
      setError(message);
      setPublishing(false);
      setPublishProgress((prev) => ({
        uploaded: prev?.uploaded ?? 0,
        skipped: prev?.skipped ?? 0,
        failed: (prev?.failed ?? 0) + 1,
        totalBytes: prev?.totalBytes ?? 0,
        errors: [...(prev?.errors ?? []), { path: prev?.currentPath ?? '.', error: message }].slice(0, 20),
        running: false,
        done: true,
        totalDiscovered: prev?.totalDiscovered ?? 0,
        startedAt: prev?.startedAt,
        finishedAt: Date.now(),
      }));
    };
    const tick = async (): Promise<void> => {
      const res = await cloudWorkspaceClient.publishStatus(session.workspaceId).catch((err): null => {
        failPublishPoll(err instanceof Error ? err.message : String(err));
        return null;
      });
      if (disposed || !aliveRef.current || !res) return;
      if (res.ok === false) {
        failPublishPoll(res.error);
        return;
      }
      setPublishProgress(res.data);
      if (!res.data.running) {
        setPublishing(false);
        await refreshStatus();
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 750);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [publishing, refreshStatus, session]);

  useEffect(() => {
    if (!session || !pulling) return;
    let disposed = false;
    const failPullPoll = (message: string): void => {
      if (disposed || !aliveRef.current) return;
      setError(message);
      setPulling(false);
      setPullProgress((prev) => ({
        uploaded: prev?.uploaded ?? 0,
        skipped: prev?.skipped ?? 0,
        failed: (prev?.failed ?? 0) + 1,
        totalBytes: prev?.totalBytes ?? 0,
        errors: [...(prev?.errors ?? []), { path: prev?.currentPath ?? '.', error: message }].slice(0, 20),
        running: false,
        done: true,
        totalDiscovered: prev?.totalDiscovered ?? 0,
        startedAt: prev?.startedAt,
        finishedAt: Date.now(),
      }));
    };
    const tick = async (): Promise<void> => {
      const res = await cloudWorkspaceClient.pullStatus(session.workspaceId).catch((err): null => {
        failPullPoll(err instanceof Error ? err.message : String(err));
        return null;
      });
      if (disposed || !aliveRef.current || !res) return;
      if (res.ok === false) {
        failPullPoll(res.error);
        return;
      }
      setPullProgress(res.data);
      if (!res.data.running) setPulling(false);
    };
    void tick();
    const timer = setInterval(() => void tick(), 300);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [pulling, session]);

  return useMemo(
    () => ({
      connected: session !== null,
      session,
      manifest,
      state,
      replica,
      busy,
      publishing,
      pulling,
      publishProgress,
      pullProgress,
      error,
      connect,
      disconnect,
      publishLocal,
      pullCloud,
      claimFile,
      releaseFile,
      refreshStatus,
      syncNow,
      resolveConflict,
    }),
    [
      session,
      manifest,
      state,
      replica,
      busy,
      publishing,
      pulling,
      publishProgress,
      pullProgress,
      error,
      connect,
      disconnect,
      publishLocal,
      pullCloud,
      claimFile,
      releaseFile,
      refreshStatus,
      syncNow,
      resolveConflict,
    ]
  );
};

export default useCloudWorkspace;
