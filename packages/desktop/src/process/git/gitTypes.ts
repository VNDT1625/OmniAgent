/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the Git Manager (Settings › Git + the IDE Git panel).
 *
 * The Git Manager is a real GitHub-backed repo manager: register a repo by URL +
 * token, clone it down, commit + push local changes up, pull updates back, and
 * keep a two-way backup. These types are renderer-safe (TYPES only, no Node
 * APIs) so the renderer imports them with `import type` across the process
 * boundary.
 *
 * Process boundary note: declares TYPES only — safe in both Main and Renderer.
 */

/** A managed repository the user has registered with the Git Manager. */
export type GitRepo = {
  /** Stable id (uuid). */
  id: string;
  /** Human label (defaults to the repo name parsed from the URL). */
  name: string;
  /** The remote URL (https form, e.g. `https://github.com/owner/repo.git`). */
  remoteUrl: string;
  /** Absolute local path the repo is cloned to / managed from. */
  localPath: string;
  /** Default branch to push/pull (e.g. `main`). */
  branch: string;
  /**
   * Id of the credential used for auth, or null for a public repo / ambient
   * credentials (the user's git credential helper). The token itself is NEVER
   * stored here — only the credential id.
   */
  credentialId: string | null;
  /** Epoch ms created. */
  createdAt: number;
  /** Epoch ms of the last successful push, or null. */
  lastPushAt: number | null;
  /** Epoch ms of the last successful pull, or null. */
  lastPullAt: number | null;
};

/**
 * A stored credential (a Personal Access Token). The secret is encrypted at rest
 * via Electron `safeStorage`; this metadata shape is what the renderer sees — it
 * NEVER carries the decrypted token.
 */
export type GitCredential = {
  /** Stable id (uuid). */
  id: string;
  /** Human label (e.g. "GitHub personal"). */
  label: string;
  /** Git host this credential authenticates against (e.g. `github.com`). */
  host: string;
  /** Username associated with the token (GitHub ignores it but git wants one). */
  username: string;
  /** Last 4 chars of the token, for the user to recognise it (never the full token). */
  tokenHint: string;
  /** Epoch ms created. */
  createdAt: number;
};

/** Working-tree status summary for a managed repo. */
export type GitRepoStatus = {
  /** Whether the local path is a git repository. */
  isRepo: boolean;
  /** Current branch name, or null when detached / not a repo. */
  branch: string | null;
  /** Count of changed files (staged + unstaged + untracked). */
  changedCount: number;
  /** Commits the local branch is ahead of its upstream. */
  ahead: number;
  /** Commits the local branch is behind its upstream. */
  behind: number;
  /** True when a remote `origin` is configured. */
  hasRemote: boolean;
};

/** A single changed file in a repo (mirrors the IDE Git panel shape). */
export type GitFileChange = {
  /** Relative path (forward-slash). */
  path: string;
  /** M(odified) / A(dded) / D(eleted) / R(enamed) / U(ntracked) / ?(unknown). */
  status: 'M' | 'A' | 'D' | 'R' | 'U' | '?';
  /** Whether the change is staged. */
  staged: boolean;
};

/** One commit in the repo log. */
export type GitCommit = {
  /** Short hash. */
  hash: string;
  /** Subject line. */
  subject: string;
  /** Author name. */
  author: string;
  /** Relative date (e.g. "2 hours ago"). */
  date: string;
};

/** The outcome of a long git operation (push/pull/clone), with captured output. */
export type GitOpResult = {
  /** Whether the operation succeeded. */
  ok: boolean;
  /** Combined stdout/stderr (token-redacted), for the user to read. */
  output: string;
};

/** Always-resolving envelope for every Git Manager IPC channel. */
export type GitResult<T> = { ok: true; data: T } | { ok: false; error: string };
