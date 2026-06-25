/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real {@link GitRunner} + {@link PrOpener} for {@link createReleasePublisher}
 * (Yêu cầu 6). Kept separate from `releasePublisher.ts` so the publisher logic
 * stays pure/unit-testable while the actual process spawning lives here.
 *
 * - {@link createGitRunner} spawns `git` in the repo root via `execFile` (no
 *   shell, args as an array → no command injection).
 * - {@link createPrOpener} opens a PR with the GitHub CLI (`gh`) when installed;
 *   if `gh` is missing/fails it resolves a clickable GitHub `compare` URL built
 *   from the remote URL, so the user can open the PR manually.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { execFile } from 'node:child_process';
import type { GitRunner, PrOpener } from './releasePublisher';

/** Max buffer for git/gh output (1 MB is plenty for our commands). */
const MAX_BUFFER = 1024 * 1024;

/** Default timeout for a single git/gh invocation (ms). */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Run an executable with args (no shell) and capture stdout/stderr + exit code. */
const exec = (
  file: string,
  args: string[],
  cwd: string,
  timeout: number
): Promise<{ stdout: string; stderr: string; code: number }> =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, timeout, maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => {
      const code =
        error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : error
            ? 1
            : 0;
      resolve({ stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '', code });
    });
  });

/**
 * Create a {@link GitRunner} that spawns `git` in `repoRoot`.
 *
 * @param repoRoot Absolute path of the repository.
 * @param timeoutMs Per-command timeout (defaults to 60s).
 */
export const createGitRunner = (repoRoot: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): GitRunner => ({
  run: (args) => exec('git', args, repoRoot, timeoutMs),
});

/** Build a GitHub "compare" URL from a remote URL (ssh or https forms). */
export const buildCompareUrl = (remoteUrl: string, base: string, branch: string): string | undefined => {
  const ssh = remoteUrl.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  const https = remoteUrl.match(/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  const m = ssh ?? https;
  if (!m) return undefined;
  const [, owner, repo] = m;
  return `https://github.com/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
};

/**
 * Create a {@link PrOpener} backed by the GitHub CLI (`gh`). When `gh` succeeds
 * it returns the created PR URL; otherwise it returns a `compareUrl` built from
 * the remote URL so the user can open the PR from the browser.
 *
 * @param repoRoot Absolute path of the repository.
 */
export const createPrOpener = (repoRoot: string): PrOpener => ({
  open: async ({ remote, branch, base, title, body }) => {
    // Resolve the remote URL up-front so we always have a compare-URL fallback.
    const remoteRes = await exec('git', ['remote', 'get-url', remote], repoRoot, DEFAULT_TIMEOUT_MS);
    const compareUrl = remoteRes.code === 0 ? buildCompareUrl(remoteRes.stdout.trim(), base, branch) : undefined;

    const gh = await exec(
      'gh',
      ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body', body],
      repoRoot,
      DEFAULT_TIMEOUT_MS
    ).catch(() => ({
      stdout: '',
      stderr: 'gh not available',
      code: 1,
    }));

    if (gh.code === 0) {
      const prUrl = gh.stdout
        .trim()
        .split(/\s+/)
        .find((t) => /^https?:\/\//.test(t));
      if (prUrl) return { prUrl, compareUrl };
    }
    return { compareUrl };
  },
});
