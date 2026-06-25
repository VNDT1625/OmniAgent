/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * State hook for the Git Manager page.
 *
 * Loads the registered repos + stored credentials through {@link gitManagerClient},
 * keeps the repo list live via the bridge's `repos-changed` push stream, and
 * exposes the repo operations (register, clone down, commit, push up, pull back,
 * remove) plus credential CRUD.
 *
 * Degrades gracefully: when the bridge is not wired the first list call times
 * out and `status` becomes `unavailable`, so the page shows a Retry notice
 * rather than hanging.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { useCallback, useEffect, useState } from 'react';
import type { GitCredential, GitOpResult, GitRepo, GitRepoStatus } from '@process/git/gitTypes';
import type { AddCredentialRequest, RegisterRepoRequest } from '@process/git/gitManagerBridge';
import { gitManagerClient } from './gitManagerClient';

/** Connection status of the Git Manager bridge as seen by the page. */
export type GitBridgeStatus = 'loading' | 'ready' | 'unavailable';

/** The live state surfaced to the Git Manager page. */
export type GitManagerState = {
  status: GitBridgeStatus;
  repos: GitRepo[];
  credentials: GitCredential[];
  /** Per-repo status snapshot (branch, ahead/behind, change count). */
  repoStatuses: Record<string, GitRepoStatus>;
  /** Id of the repo currently running a long op (clone/push/pull), or null. */
  busyRepoId: string | null;
  registerRepo: (req: RegisterRepoRequest) => Promise<GitRepo | null>;
  removeRepo: (id: string) => Promise<void>;
  refreshStatus: (id: string) => Promise<void>;
  clone: (id: string) => Promise<GitOpResult | null>;
  commit: (id: string, message: string) => Promise<GitOpResult | null>;
  push: (id: string) => Promise<GitOpResult | null>;
  pull: (id: string) => Promise<GitOpResult | null>;
  addCredential: (req: AddCredentialRequest) => Promise<boolean>;
  removeCredential: (id: string) => Promise<void>;
  retry: () => void;
};

export const useGitManager = (): GitManagerState => {
  const [status, setStatus] = useState<GitBridgeStatus>('loading');
  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [credentials, setCredentials] = useState<GitCredential[]>([]);
  const [repoStatuses, setRepoStatuses] = useState<Record<string, GitRepoStatus>>({});
  const [busyRepoId, setBusyRepoId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Initial load + live subscription.
  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const reposRes = await gitManagerClient.listRepos();
        if (cancelled) return;
        if (!reposRes.ok) {
          setStatus('unavailable');
          return;
        }
        setRepos(reposRes.data);
        setStatus('ready');
        // Credentials are non-critical; load best-effort.
        const credRes = await gitManagerClient.listCredentials().catch((): null => null);
        if (cancelled) return;
        if (credRes?.ok) setCredentials(credRes.data);
        // Hydrate each repo's status snapshot in the background.
        for (const repo of reposRes.data) {
          void gitManagerClient
            .repoStatus({ id: repo.id })
            .then((res) => {
              if (!cancelled && res.ok) setRepoStatuses((prev) => ({ ...prev, [repo.id]: res.data }));
            })
            .catch(() => {});
        }
      } catch {
        if (!cancelled) setStatus('unavailable');
      }
    };

    void load();
    const off = gitManagerClient.onReposChanged((next) => setRepos(next));
    return () => {
      cancelled = true;
      off();
    };
  }, [reloadToken]);

  const refreshStatus = useCallback(async (id: string): Promise<void> => {
    const res = await gitManagerClient.repoStatus({ id }).catch((): null => null);
    if (res?.ok) setRepoStatuses((prev) => ({ ...prev, [id]: res.data }));
  }, []);

  const registerRepo = useCallback(
    async (req: RegisterRepoRequest): Promise<GitRepo | null> => {
      setBusyRepoId('__register__');
      try {
        const res = await gitManagerClient.registerRepo(req).catch((): null => null);
        if (!res || !res.ok) return null;
        void refreshStatus(res.data.id);
        return res.data;
      } finally {
        setBusyRepoId(null);
      }
    },
    [refreshStatus]
  );

  const removeRepo = useCallback(async (id: string): Promise<void> => {
    await gitManagerClient.removeRepo({ id }).catch(() => {});
  }, []);

  const runOp = useCallback(
    async (id: string, op: () => Promise<{ ok: boolean; data?: GitOpResult }>): Promise<GitOpResult | null> => {
      setBusyRepoId(id);
      try {
        const res = await op().catch((): null => null);
        await refreshStatus(id);
        if (!res || !res.ok || !res.data) return null;
        return res.data;
      } finally {
        setBusyRepoId(null);
      }
    },
    [refreshStatus]
  );

  const clone = useCallback((id: string) => runOp(id, () => gitManagerClient.clone({ id })), [runOp]);
  const commit = useCallback(
    (id: string, message: string) => runOp(id, () => gitManagerClient.commit({ id, message })),
    [runOp]
  );
  const push = useCallback((id: string) => runOp(id, () => gitManagerClient.push({ id })), [runOp]);
  const pull = useCallback((id: string) => runOp(id, () => gitManagerClient.pull({ id })), [runOp]);

  const addCredential = useCallback(async (req: AddCredentialRequest): Promise<boolean> => {
    const res = await gitManagerClient.addCredential(req).catch((): null => null);
    if (res?.ok) {
      const listRes = await gitManagerClient.listCredentials().catch((): null => null);
      if (listRes?.ok) setCredentials(listRes.data);
      return true;
    }
    return false;
  }, []);

  const removeCredential = useCallback(async (id: string): Promise<void> => {
    const res = await gitManagerClient.removeCredential({ id }).catch((): null => null);
    if (res?.ok) setCredentials(res.data);
  }, []);

  const retry = useCallback((): void => {
    setStatus('loading');
    setReloadToken((t) => t + 1);
  }, []);

  return {
    status,
    repos,
    credentials,
    repoStatuses,
    busyRepoId,
    registerRepo,
    removeRepo,
    refreshStatus,
    clone,
    commit,
    push,
    pull,
    addCredential,
    removeCredential,
    retry,
  };
};
