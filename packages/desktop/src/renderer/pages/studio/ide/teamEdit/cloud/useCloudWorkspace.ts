/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** React state controller for one cloud-authoritative IDE workspace session. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CloudWorkspaceManifest, CloudWorkspaceSyncState } from '@/common/adapter/cloudWorkspaceMapper';
import { cloudWorkspaceClient, type CloudWorkspaceSessionData } from './cloudWorkspaceClient';
import type { PeerConnection } from '../useTeamCollab';

export type CloudWorkspaceConnection = PeerConnection & {
  relayBaseUrl: string;
  workspaceId: string;
};

export type UseCloudWorkspace = {
  connected: boolean;
  session: CloudWorkspaceConnection | null;
  manifest: CloudWorkspaceManifest | null;
  state: CloudWorkspaceSyncState | null;
  busy: boolean;
  error: string | null;
  connect: (relayBaseUrl: string, workspaceId: string, token: string, displayName?: string) => Promise<boolean>;
  disconnect: () => Promise<void>;
  refreshStatus: () => Promise<void>;
};

const toConnection = (data: CloudWorkspaceSessionData): CloudWorkspaceConnection => ({
  baseUrl: data.config.relayBaseUrl,
  token: data.config.token,
  repoName: data.config.workspaceId,
  workspacePath: data.workspacePath,
  remoteMcpServer: data.remoteMcpServer,
  relayBaseUrl: data.config.relayBaseUrl,
  workspaceId: data.config.workspaceId,
});

export const useCloudWorkspace = (): UseCloudWorkspace => {
  const [session, setSession] = useState<CloudWorkspaceConnection | null>(null);
  const [manifest, setManifest] = useState<CloudWorkspaceManifest | null>(null);
  const [state, setState] = useState<CloudWorkspaceSyncState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const applyStatus = useCallback((data: Awaited<ReturnType<typeof cloudWorkspaceClient.status>>): void => {
    if (!aliveRef.current || data.ok === false) return;
    if (!data.data.connected || !data.data.config || !data.data.workspacePath || !data.data.remoteMcpServer) {
      setSession(null);
      setManifest(null);
      setState(null);
      return;
    }
    setSession({
      baseUrl: data.data.config.relayBaseUrl,
      token: data.data.config.token,
      repoName: data.data.config.workspaceId,
      workspacePath: data.data.workspacePath,
      remoteMcpServer: data.data.remoteMcpServer,
      relayBaseUrl: data.data.config.relayBaseUrl,
      workspaceId: data.data.config.workspaceId,
    });
    setManifest(data.data.manifest ?? null);
    setState(data.data.state ?? null);
  }, []);

  const refreshStatus = useCallback(async (): Promise<void> => {
    const res = await cloudWorkspaceClient.status(session?.workspaceId).catch((): null => null);
    if (res) applyStatus(res);
  }, [applyStatus, session?.workspaceId]);

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

  const connect = useCallback(
    async (relayBaseUrl: string, workspaceId: string, token: string, displayName?: string): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      setError(null);
      try {
        const res = await cloudWorkspaceClient.connect({ relayBaseUrl, workspaceId, token, displayName });
        if (!aliveRef.current) return res.ok;
        if (res.ok === false) {
          setError(res.error);
          return false;
        }
        setSession(toConnection(res.data));
        setManifest(res.data.manifest);
        setState(res.data.state);
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
  }, [session]);

  return useMemo(
    () => ({
      connected: session !== null,
      session,
      manifest,
      state,
      busy,
      error,
      connect,
      disconnect,
      refreshStatus,
    }),
    [session, manifest, state, busy, error, connect, disconnect, refreshStatus]
  );
};

export default useCloudWorkspace;
