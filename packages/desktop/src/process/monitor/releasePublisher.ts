/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `releasePublisher` — turns an APPLIED, reviewed bug-fix (Yêu cầu 6) into a Git
 * branch + commit + (optional) push + pull request, so the user's flow is:
 *
 *   Monitor fix applied to source → publish → push branch `fix/monitor-*`
 *     → CI's AI PR review runs → user reviews → user merges → release pipeline.
 *
 * SAFETY (this is a high-blast-radius operation, so the policy is conservative):
 * - The push TARGET REMOTE is configurable and defaults to `origin`, but the
 *   publisher REFUSES to push to a remote whose URL matches the upstream project
 *   (`iOfficeAI/AionUi`) unless `allowUpstreamPush` is explicitly set — a fork
 *   must not accidentally push to the shared upstream repo.
 * - It NEVER pushes to `main`/`master`; it always works on a new `fix/monitor-*`
 *   branch.
 * - When `push` is disabled (default), it only prepares the branch + commit
 *   locally and reports the branch name, leaving the push to the user.
 *
 * All Git access + PR creation are injected ({@link GitRunner}, {@link PrOpener})
 * so this module only orchestrates and is fully unit-testable without a repo.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import type { PatchProposal } from './monitorTypes';
import { filesInDiff } from './patchApplier';

/** Runs a git subcommand; resolves the captured output + exit code. */
export type GitRunner = {
  run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
};

/** Opens a pull request for a pushed branch (gh CLI / REST / compare-URL fallback). */
export type PrOpener = {
  /** Open a PR; resolve a created PR url, or a compare url the user can click. */
  open(input: {
    remote: string;
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ prUrl?: string; compareUrl?: string }>;
};

/** Approval/safety policy for publishing (criterion 6.6 spirit — controlled release). */
export type PublisherConfig = {
  /** Remote to push to. Defaults to `origin`. */
  targetRemote?: string;
  /** Base branch the PR targets. Defaults to `main`. */
  baseBranch?: string;
  /** Branch name prefix. Defaults to `fix/monitor-`. */
  branchPrefix?: string;
  /** Actually push + open a PR. Defaults to `false` (prepare branch + commit only). */
  push?: boolean;
  /** Allow pushing even when the remote looks like the shared upstream. Defaults to `false`. */
  allowUpstreamPush?: boolean;
  /** Pattern identifying the protected upstream remote. Defaults to the AionUi upstream. */
  upstreamPattern?: RegExp;
};

/** Options for {@link createReleasePublisher}. */
export type ReleasePublisherDeps = {
  /** Git command runner (real impl shells out via execFile). */
  git: GitRunner;
  /** PR opener. */
  prOpener: PrOpener;
  /** Publish policy/config. */
  config?: PublisherConfig;
  /** Unique short id generator for branch names. Defaults to a time-based token. */
  shortId?: () => string;
};

/** Outcome of a publish attempt. */
export type PublishResult = {
  /** The branch created for the fix. */
  branch: string;
  /** Files committed (relative paths from the diff). */
  files: string[];
  /** Whether the branch was pushed to the remote. */
  pushed: boolean;
  /** Created PR url, when a PR was opened. */
  prUrl?: string;
  /** Compare url the user can click to open a PR manually. */
  compareUrl?: string;
  /** Human-readable note (e.g. "prepared locally; push disabled"). */
  note: string;
};

/** Public contract of the release publisher. */
export type IReleasePublisher = {
  /** Prepare (and optionally push + PR) a branch carrying the proposal's fix. */
  publish(proposal: PatchProposal): Promise<PublishResult>;
};

/** Default upstream remote pattern the publisher refuses to push to. */
const DEFAULT_UPSTREAM_PATTERN = /iOfficeAI\/AionUi(\.git)?$/i;

/** Build a safe, short branch name for a proposal. */
const branchName = (prefix: string, proposal: PatchProposal, shortId: () => string): string => {
  const idPart = proposal.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || shortId();
  return `${prefix}${idPart}`;
};

/** A concise, conventional commit subject (no AI signatures, per repo rules). */
const commitSubject = (proposal: PatchProposal): string => {
  const cause = proposal.rootCause.replace(/\s+/g, ' ').trim().slice(0, 60) || 'auto-detected error';
  return `fix(monitor): ${cause}`;
};

/** A PR/commit body describing the fix + provenance. */
const describeFix = (proposal: PatchProposal): string =>
  [
    `Automated fix proposed by the bug monitor (Yêu cầu 6).`,
    ``,
    `**Root cause:** ${proposal.rootCause}`,
    ``,
    `**Fix:** ${proposal.explanation}`,
    ``,
    `**Risk:** ${proposal.risk}`,
    `**Signature:** \`${proposal.signature}\``,
    ``,
    `This branch was prepared after the patch passed the isolated sandbox and was approved in the monitor gate. Please review before merging.`,
  ].join('\n');

/**
 * Create an {@link IReleasePublisher}.
 *
 * @param deps Git runner, PR opener, config. See {@link ReleasePublisherDeps}.
 * @returns A publisher that branches + commits + optionally pushes a fix.
 */
export const createReleasePublisher = (deps: ReleasePublisherDeps): IReleasePublisher => {
  const cfg = deps.config ?? {};
  const targetRemote = cfg.targetRemote ?? 'origin';
  const baseBranch = cfg.baseBranch ?? 'main';
  const branchPrefix = cfg.branchPrefix ?? 'fix/monitor-';
  const shouldPush = cfg.push ?? false;
  const allowUpstreamPush = cfg.allowUpstreamPush ?? false;
  const upstreamPattern = cfg.upstreamPattern ?? DEFAULT_UPSTREAM_PATTERN;
  const shortId = deps.shortId ?? (() => Date.now().toString(36).slice(-6));

  /** Run a git command and throw a descriptive error on non-zero exit. */
  const git = async (args: string[]): Promise<string> => {
    const { stdout, stderr, code } = await deps.git.run(args);
    if (code !== 0) {
      throw new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`);
    }
    return stdout.trim();
  };

  /** Resolve the URL of the target remote (for the upstream-protection check). */
  const remoteUrl = async (): Promise<string> => {
    try {
      return await git(['remote', 'get-url', targetRemote]);
    } catch {
      return '';
    }
  };

  const publish: IReleasePublisher['publish'] = async (proposal) => {
    const files = filesInDiff(proposal.diff).map((f) => f.relPath);
    if (files.length === 0) {
      throw new Error('[Monitor] The proposal has no files to commit.');
    }
    const branch = branchName(branchPrefix, proposal, shortId);

    // Create the branch off the current HEAD and stage exactly the patched files.
    await git(['checkout', '-b', branch]);
    await git(['add', '--', ...files]);
    await git(['commit', '-m', commitSubject(proposal), '-m', describeFix(proposal)]);

    // Prepare-only mode: leave the push to the user (default, safest).
    if (!shouldPush) {
      return {
        branch,
        files,
        pushed: false,
        note: 'Branch + commit prepared locally. Push disabled — push it yourself when ready.',
      };
    }

    // Upstream protection: refuse to push to the shared upstream repo unless
    // explicitly allowed. A fork must target its own remote.
    const url = await remoteUrl();
    if (url && upstreamPattern.test(url) && !allowUpstreamPush) {
      return {
        branch,
        files,
        pushed: false,
        note: `Refused to push to the upstream remote "${targetRemote}" (${url}). Configure a fork remote, or set allowUpstreamPush to override.`,
      };
    }

    await git(['push', '-u', targetRemote, branch]);

    const { prUrl, compareUrl } = await deps.prOpener.open({
      remote: targetRemote,
      branch,
      base: baseBranch,
      title: commitSubject(proposal),
      body: describeFix(proposal),
    });

    return {
      branch,
      files,
      pushed: true,
      prUrl,
      compareUrl,
      note: prUrl ? 'Pushed and opened a pull request.' : 'Pushed. Open the pull request from the compare link.',
    };
  };

  return { publish };
};
