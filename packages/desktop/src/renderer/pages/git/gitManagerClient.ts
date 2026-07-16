/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the Git Manager IPC surface.
 *
 * The Main-process bridge (`process/git/gitManagerBridge.ts`) pulls in Electron
 * + Node (`child_process`, `safeStorage`, `fs`), so it must NOT be imported into
 * the renderer at runtime. Mirroring `terminalBridgeClient.ts`, this module:
 *
 * - re-declares the channel-name strings (kept in sync with `GIT_MANAGER_CHANNELS`),
 * - rebuilds matching `bridge.buildProvider` / `bridge.buildEmitter` invokers,
 * - wraps each request with a timeout so an unregistered channel rejects instead
 *   of hanging (the page then shows a friendly "not ready" notice).
 *
 * Only **types** are borrowed from the Main module via `import type`.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type {
  AddCredentialRequest,
  CommitRequest,
  CredentialIdRequest,
  RegisterRepoRequest,
  RepoIdRequest,
  RepoLogRequest,
} from '@process/git/gitManagerBridge';
import type {
  GitCommit,
  GitCredential,
  GitFileChange,
  GitOpResult,
  GitRepo,
  GitRepoStatus,
  GitResult,
} from '@process/git/gitTypes';

/** Git Manager IPC channel names. Mirrors `GIT_MANAGER_CHANNELS`. */
const GIT_CHANNELS = {
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

/** How long to wait for a quick IPC reply before treating the bridge as not wired. */
const QUICK_TIMEOUT_MS = 6000;
/** Longer budget for network ops (clone/push/pull can take a while). */
const NET_TIMEOUT_MS = 180_000;

const channels = {
  listRepos: bridge.buildProvider<GitResult<GitRepo[]>, void>(GIT_CHANNELS.listRepos),
  registerRepo: bridge.buildProvider<GitResult<GitRepo>, RegisterRepoRequest>(GIT_CHANNELS.registerRepo),
  removeRepo: bridge.buildProvider<GitResult<GitRepo[]>, RepoIdRequest>(GIT_CHANNELS.removeRepo),
  repoStatus: bridge.buildProvider<GitResult<GitRepoStatus>, RepoIdRequest>(GIT_CHANNELS.repoStatus),
  repoChanges: bridge.buildProvider<GitResult<GitFileChange[]>, RepoIdRequest>(GIT_CHANNELS.repoChanges),
  repoLog: bridge.buildProvider<GitResult<GitCommit[]>, RepoLogRequest>(GIT_CHANNELS.repoLog),
  clone: bridge.buildProvider<GitResult<GitOpResult>, RepoIdRequest>(GIT_CHANNELS.clone),
  commit: bridge.buildProvider<GitResult<GitOpResult>, CommitRequest>(GIT_CHANNELS.commit),
  push: bridge.buildProvider<GitResult<GitOpResult>, RepoIdRequest>(GIT_CHANNELS.push),
  pull: bridge.buildProvider<GitResult<GitOpResult>, RepoIdRequest>(GIT_CHANNELS.pull),
  listCredentials: bridge.buildProvider<GitResult<GitCredential[]>, void>(GIT_CHANNELS.listCredentials),
  addCredential: bridge.buildProvider<GitResult<GitCredential>, AddCredentialRequest>(GIT_CHANNELS.addCredential),
  removeCredential: bridge.buildProvider<GitResult<GitCredential[]>, CredentialIdRequest>(
    GIT_CHANNELS.removeCredential
  ),
  reposChanged: bridge.buildEmitter<GitRepo[]>(GIT_CHANNELS.reposChanged),
};

/** Error thrown when a Git Manager IPC call does not reply within its budget. */
export class GitBridgeTimeoutError extends Error {
  constructor(channel: string) {
    super(`[GitManagerClient] No reply on "${channel}" — the Git Manager bridge may not be wired yet.`);
    this.name = 'GitBridgeTimeoutError';
  }
}

/** Race an `invoke` against a timeout so a missing handler rejects, not hangs. */
const withTimeout = <T>(channel: string, call: () => Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new GitBridgeTimeoutError(channel));
    }, timeoutMs);
    call().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

/** Timeout-guarded Git Manager client for the renderer. */
export const gitManagerClient = {
  listRepos: () => withTimeout(GIT_CHANNELS.listRepos, () => channels.listRepos.invoke(), QUICK_TIMEOUT_MS),
  registerRepo: (req: RegisterRepoRequest) =>
    withTimeout(GIT_CHANNELS.registerRepo, () => channels.registerRepo.invoke(req), NET_TIMEOUT_MS),
  removeRepo: (req: RepoIdRequest) =>
    withTimeout(GIT_CHANNELS.removeRepo, () => channels.removeRepo.invoke(req), QUICK_TIMEOUT_MS),
  repoStatus: (req: RepoIdRequest) =>
    withTimeout(GIT_CHANNELS.repoStatus, () => channels.repoStatus.invoke(req), QUICK_TIMEOUT_MS),
  repoChanges: (req: RepoIdRequest) =>
    withTimeout(GIT_CHANNELS.repoChanges, () => channels.repoChanges.invoke(req), QUICK_TIMEOUT_MS),
  repoLog: (req: RepoLogRequest) =>
    withTimeout(GIT_CHANNELS.repoLog, () => channels.repoLog.invoke(req), QUICK_TIMEOUT_MS),
  clone: (req: RepoIdRequest) => withTimeout(GIT_CHANNELS.clone, () => channels.clone.invoke(req), NET_TIMEOUT_MS),
  commit: (req: CommitRequest) => withTimeout(GIT_CHANNELS.commit, () => channels.commit.invoke(req), QUICK_TIMEOUT_MS),
  push: (req: RepoIdRequest) => withTimeout(GIT_CHANNELS.push, () => channels.push.invoke(req), NET_TIMEOUT_MS),
  pull: (req: RepoIdRequest) => withTimeout(GIT_CHANNELS.pull, () => channels.pull.invoke(req), NET_TIMEOUT_MS),
  listCredentials: () =>
    withTimeout(GIT_CHANNELS.listCredentials, () => channels.listCredentials.invoke(), QUICK_TIMEOUT_MS),
  addCredential: (req: AddCredentialRequest) =>
    withTimeout(GIT_CHANNELS.addCredential, () => channels.addCredential.invoke(req), QUICK_TIMEOUT_MS),
  removeCredential: (req: CredentialIdRequest) =>
    withTimeout(GIT_CHANNELS.removeCredential, () => channels.removeCredential.invoke(req), QUICK_TIMEOUT_MS),
  /** Subscribe to the full repo-list snapshot whenever it changes. Returns an unsubscribe fn. */
  onReposChanged: (listener: (repos: GitRepo[]) => void): (() => void) => channels.reposChanged.on(listener),
};
