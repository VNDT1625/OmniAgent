/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `gitManagerBridge` — IPC surface for the Git Manager (Settings › Git). Exposes
 * the repo store, the encrypted credential store, and the real git runner to the
 * renderer behind an always-resolving {@link GitResult} envelope (so the page
 * never hangs even if git is missing).
 *
 * Channels:
 *  - credentials: list / add / remove (tokens encrypted at rest; never returned)
 *  - repos:       list / register / remove / status
 *  - operations:  clone (down), commit, push (up), pull (back), changes, log
 *
 * The decrypted token NEVER crosses to the renderer: a push/pull/clone resolves
 * the credential in Main, hands it to the runner, and only the token-redacted
 * command output is returned.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import type { IGitCredentialStore } from './gitCredentialStore';
import type { IGitRepoStore } from './gitRepoStore';
import type { IGitRunner } from './gitRunner';
import type {
  GitCommit,
  GitCredential,
  GitFileChange,
  GitOpResult,
  GitRepo,
  GitRepoStatus,
  GitResult,
} from './gitTypes';

/** IPC channel names (renderer-safe contract). */
export const GIT_MANAGER_CHANNELS = {
  listRepos: 'gitmgr.list-repos',
  registerRepo: 'gitmgr.register-repo',
  removeRepo: 'gitmgr.remove-repo',
  repoStatus: 'gitmgr.repo-status',
  repoChanges: 'gitmgr.repo-changes',
  repoLog: 'gitmgr.repo-log',
  clone: 'gitmgr.clone',
  commit: 'gitmgr.commit',
  push: 'gitmgr.push',
  pull: 'gitmgr.pull',
  listCredentials: 'gitmgr.list-credentials',
  addCredential: 'gitmgr.add-credential',
  removeCredential: 'gitmgr.remove-credential',
  reposChanged: 'gitmgr.repos-changed',
} as const;

// --- request payloads ------------------------------------------------------

export type RegisterRepoRequest = {
  remoteUrl: string;
  localPath: string;
  branch?: string;
  name?: string;
  credentialId?: string | null;
  /** When true, clone the remote into localPath right after registering. */
  cloneNow?: boolean;
};
export type RepoIdRequest = { id: string };
export type CommitRequest = { id: string; message: string };
export type RepoLogRequest = { id: string; limit?: number };
export type AddCredentialRequest = { label: string; host: string; username: string; token: string };
export type CredentialIdRequest = { id: string };

// --- typed channels --------------------------------------------------------

export const gitManagerChannels = {
  listRepos: bridge.buildProvider<GitResult<GitRepo[]>, void>(GIT_MANAGER_CHANNELS.listRepos),
  registerRepo: bridge.buildProvider<GitResult<GitRepo>, RegisterRepoRequest>(GIT_MANAGER_CHANNELS.registerRepo),
  removeRepo: bridge.buildProvider<GitResult<GitRepo[]>, RepoIdRequest>(GIT_MANAGER_CHANNELS.removeRepo),
  repoStatus: bridge.buildProvider<GitResult<GitRepoStatus>, RepoIdRequest>(GIT_MANAGER_CHANNELS.repoStatus),
  repoChanges: bridge.buildProvider<GitResult<GitFileChange[]>, RepoIdRequest>(GIT_MANAGER_CHANNELS.repoChanges),
  repoLog: bridge.buildProvider<GitResult<GitCommit[]>, RepoLogRequest>(GIT_MANAGER_CHANNELS.repoLog),
  clone: bridge.buildProvider<GitResult<GitOpResult>, RepoIdRequest>(GIT_MANAGER_CHANNELS.clone),
  commit: bridge.buildProvider<GitResult<GitOpResult>, CommitRequest>(GIT_MANAGER_CHANNELS.commit),
  push: bridge.buildProvider<GitResult<GitOpResult>, RepoIdRequest>(GIT_MANAGER_CHANNELS.push),
  pull: bridge.buildProvider<GitResult<GitOpResult>, RepoIdRequest>(GIT_MANAGER_CHANNELS.pull),
  listCredentials: bridge.buildProvider<GitResult<GitCredential[]>, void>(GIT_MANAGER_CHANNELS.listCredentials),
  addCredential: bridge.buildProvider<GitResult<GitCredential>, AddCredentialRequest>(
    GIT_MANAGER_CHANNELS.addCredential
  ),
  removeCredential: bridge.buildProvider<GitResult<GitCredential[]>, CredentialIdRequest>(
    GIT_MANAGER_CHANNELS.removeCredential
  ),
  reposChanged: bridge.buildEmitter<GitRepo[]>(GIT_MANAGER_CHANNELS.reposChanged),
};

/** Services the Git Manager bridge operates on. */
export type GitManagerServices = {
  repoStore: IGitRepoStore;
  credentialStore: IGitCredentialStore;
  runner: IGitRunner;
};

export type RegisterGitManagerBridgeOptions = { services: GitManagerServices };

let unsubscribers: Array<() => void> = [];

/**
 * Register the Git Manager IPC handlers + the repos-changed push stream.
 * Idempotent: a repeated call re-registers the providers and replaces prior
 * subscriptions. Invoked once during Main-process bootstrap.
 */
export function registerGitManagerBridge(options: RegisterGitManagerBridgeOptions): void {
  const { repoStore, credentialStore, runner } = options.services;

  /** Wrap a handler so it ALWAYS resolves a {@link GitResult}. */
  const safe =
    <Req, Res>(label: string, handler: (req: Req) => Promise<Res> | Res) =>
    async (req: Req): Promise<GitResult<Res>> => {
      try {
        return { ok: true, data: await handler(req) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[GitManagerBridge] ${label} failed:`, message);
        return { ok: false, error: message };
      }
    };

  /** Resolve a repo's credential (decrypted, Main-only) or undefined. */
  const resolveCred = async (credentialId: string | null) => {
    if (!credentialId) return undefined;
    const resolved = await credentialStore.resolve(credentialId);
    return resolved ?? undefined;
  };

  // --- repos --------------------------------------------------------------
  gitManagerChannels.listRepos.provider(safe('listRepos', () => repoStore.list()));

  gitManagerChannels.registerRepo.provider(
    safe('registerRepo', async (req: RegisterRepoRequest) => {
      const repo = await repoStore.add({
        remoteUrl: req.remoteUrl,
        localPath: req.localPath,
        branch: req.branch,
        name: req.name,
        credentialId: req.credentialId ?? null,
      });
      // Optionally clone the remote down right away (the "down" direction).
      if (req.cloneNow) {
        const cred = await resolveCred(repo.credentialId);
        await runner.clone(repo.remoteUrl, repo.localPath, repo.branch, cred);
      }
      return repo;
    })
  );

  gitManagerChannels.removeRepo.provider(safe('removeRepo', ({ id }: RepoIdRequest) => repoStore.remove(id)));

  gitManagerChannels.repoStatus.provider(
    safe('repoStatus', async ({ id }: RepoIdRequest) => {
      const repo = await repoStore.get(id);
      if (!repo) throw new Error('Repo not found.');
      return runner.status(repo.localPath);
    })
  );

  gitManagerChannels.repoChanges.provider(
    safe('repoChanges', async ({ id }: RepoIdRequest) => {
      const repo = await repoStore.get(id);
      if (!repo) throw new Error('Repo not found.');
      return runner.changes(repo.localPath);
    })
  );

  gitManagerChannels.repoLog.provider(
    safe('repoLog', async ({ id, limit }: RepoLogRequest) => {
      const repo = await repoStore.get(id);
      if (!repo) throw new Error('Repo not found.');
      return runner.log(repo.localPath, limit);
    })
  );

  // --- operations ---------------------------------------------------------
  gitManagerChannels.clone.provider(
    safe('clone', async ({ id }: RepoIdRequest): Promise<GitOpResult> => {
      const repo = await repoStore.get(id);
      if (!repo) throw new Error('Repo not found.');
      const cred = await resolveCred(repo.credentialId);
      const res = await runner.clone(repo.remoteUrl, repo.localPath, repo.branch, cred);
      if (res.ok) await repoStore.patch(id, { lastPullAt: Date.now() });
      return res;
    })
  );

  gitManagerChannels.commit.provider(
    safe('commit', async ({ id, message }: CommitRequest): Promise<GitOpResult> => {
      const repo = await repoStore.get(id);
      if (!repo) throw new Error('Repo not found.');
      if (!message.trim()) throw new Error('A commit message is required.');
      return runner.commitAll(repo.localPath, message.trim());
    })
  );

  gitManagerChannels.push.provider(
    safe('push', async ({ id }: RepoIdRequest): Promise<GitOpResult> => {
      const repo = await repoStore.get(id);
      if (!repo) throw new Error('Repo not found.');
      const cred = await resolveCred(repo.credentialId);
      const res = await runner.push(repo.localPath, repo.branch, cred);
      if (res.ok) await repoStore.patch(id, { lastPushAt: Date.now() });
      return res;
    })
  );

  gitManagerChannels.pull.provider(
    safe('pull', async ({ id }: RepoIdRequest): Promise<GitOpResult> => {
      const repo = await repoStore.get(id);
      if (!repo) throw new Error('Repo not found.');
      const cred = await resolveCred(repo.credentialId);
      const res = await runner.pull(repo.localPath, repo.branch, cred);
      if (res.ok) await repoStore.patch(id, { lastPullAt: Date.now() });
      return res;
    })
  );

  // --- credentials --------------------------------------------------------
  gitManagerChannels.listCredentials.provider(safe('listCredentials', () => credentialStore.list()));
  gitManagerChannels.addCredential.provider(
    safe('addCredential', (req: AddCredentialRequest) => credentialStore.add(req))
  );
  gitManagerChannels.removeCredential.provider(
    safe('removeCredential', async ({ id }: CredentialIdRequest) => {
      await credentialStore.remove(id);
      return credentialStore.list();
    })
  );

  // --- live push stream ---------------------------------------------------
  for (const off of unsubscribers) off();
  unsubscribers = [repoStore.onChange((repos) => gitManagerChannels.reposChanged.emit(repos))];
}

/** Detach the live push subscriptions (deterministic teardown for tests). */
export function disposeGitManagerBridge(): void {
  for (const off of unsubscribers) off();
  unsubscribers = [];
}
