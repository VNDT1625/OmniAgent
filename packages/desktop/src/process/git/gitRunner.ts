/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `gitRunner` — runs real `git` operations for the Git Manager: clone, status,
 * log, stage, commit, push, pull. The user's `PATH` `git` is invoked via
 * `child_process.spawn` (mirrors how a developer runs it).
 *
 * ## Auth without leaking the token
 *
 * For push/pull/clone against an https remote, the token is supplied to git via
 * the `http.extraheader` config flag with an `Authorization: Basic` header,
 * passed as a one-shot `-c` argument (NOT written to `.git/config`, NOT in the
 * URL, NOT in an env var that other processes inherit). The Authorization value
 * is base64 so it never appears in plaintext in a process listing, and every
 * captured stdout/stderr line is run through {@link redact} before it is shown
 * to the user — so a token can never surface in the UI or logs.
 *
 * ## Safety
 *
 * - Push targets the repo's configured branch; pushing to `main`/`master` is
 *   allowed but the bridge surfaces a confirmation in the UI first.
 * - All commands are argument-arrays (never a shell string), so a path or
 *   message with spaces / quotes can't inject extra commands.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { spawn } from 'node:child_process';
import type { GitCommit, GitFileChange, GitRepoStatus } from './gitTypes';

/** Resolved credential the runner uses for an authenticated remote op. */
export type ResolvedCredential = { username: string; token: string };

/** Captured result of a raw git invocation. */
type RawResult = { code: number; stdout: string; stderr: string };

/** Max bytes captured from a single git command's output. */
const MAX_OUTPUT_BYTES = 512_000;

/**
 * Redact anything that looks like a token from text shown to the user. Covers
 * the known token (when provided) plus common PAT shapes (ghp_, github_pat_,
 * gho_, etc.) so even an unexpected echo is scrubbed.
 */
export const redact = (text: string, token?: string): string => {
  let out = text;
  if (token && token.length >= 4) {
    out = out.split(token).join('***');
  }
  // Generic GitHub token shapes.
  out = out.replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '$1_***');
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_***');
  // A Basic auth blob (base64 user:token) in an extraheader echo.
  out = out.replace(/Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi, 'Authorization: Basic ***');
  return out;
};

/** Build the one-shot `-c http.extraheader=...` arg carrying Basic auth. */
const authArgs = (cred?: ResolvedCredential): string[] => {
  if (!cred) return [];
  const basic = Buffer.from(`${cred.username}:${cred.token}`, 'utf-8').toString('base64');
  return ['-c', `http.extraheader=Authorization: Basic ${basic}`];
};

/** Injectable spawn seam so tests don't shell out to real git. */
export type GitSpawn = (args: string[], cwd: string | undefined) => Promise<RawResult>;

const defaultSpawn: GitSpawn = (args, cwd) =>
  new Promise<RawResult>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      // Disable interactive credential prompts: fail fast instead of hanging.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let total = 0;
    const push = (arr: Buffer[], buf: Buffer): void => {
      total += buf.length;
      if (total <= MAX_OUTPUT_BYTES) arr.push(buf);
    };
    child.stdout.on('data', (b: Buffer) => push(stdoutChunks, b));
    child.stderr.on('data', (b: Buffer) => push(stderrChunks, b));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      })
    );
  });

/** Public contract of the git runner. */
export type IGitRunner = {
  /** Clone `remoteUrl` into `localPath` using the optional credential. */
  clone(
    remoteUrl: string,
    localPath: string,
    branch: string,
    cred?: ResolvedCredential
  ): Promise<{ ok: boolean; output: string }>;
  /** Working-tree status summary (branch, change count, ahead/behind). */
  status(localPath: string): Promise<GitRepoStatus>;
  /** Changed files (staged + unstaged + untracked). */
  changes(localPath: string): Promise<GitFileChange[]>;
  /** Recent commits (most recent first). */
  log(localPath: string, limit?: number): Promise<GitCommit[]>;
  /** Stage all changes + commit with `message`. Returns false when nothing to commit. */
  commitAll(
    localPath: string,
    message: string,
    author?: { name: string; email: string }
  ): Promise<{ ok: boolean; output: string }>;
  /** Push the repo's branch to origin, setting upstream when needed. */
  push(localPath: string, branch: string, cred?: ResolvedCredential): Promise<{ ok: boolean; output: string }>;
  /** Pull (fetch + merge) the branch from origin. */
  pull(localPath: string, branch: string, cred?: ResolvedCredential): Promise<{ ok: boolean; output: string }>;
  /** Initialise a repo in `localPath` and set its origin remote. */
  initAndSetRemote(localPath: string, remoteUrl: string, branch: string): Promise<{ ok: boolean; output: string }>;
};

/** Options for {@link createGitRunner}. */
export type GitRunnerOptions = { spawn?: GitSpawn };

/** Create a git runner. Inject `spawn` in tests to avoid real git. */
export const createGitRunner = (options?: GitRunnerOptions): IGitRunner => {
  const run = options?.spawn ?? defaultSpawn;

  /** Run git and return the redacted combined output + ok flag. */
  const exec = async (
    args: string[],
    cwd: string | undefined,
    token?: string
  ): Promise<{ ok: boolean; output: string }> => {
    try {
      const res = await run(args, cwd);
      const combined = [res.stdout, res.stderr].filter((s) => s.trim().length > 0).join('\n');
      return {
        ok: res.code === 0,
        output: redact(combined, token) || (res.code === 0 ? 'Done.' : `git exited with code ${res.code}`),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, output: redact(msg, token) };
    }
  };

  /** Run git and return stdout (throws on non-zero), for parse-only commands. */
  const read = async (args: string[], cwd: string): Promise<string> => {
    const res = await run(args, cwd);
    if (res.code !== 0) throw new Error(res.stderr.trim() || `git exited with code ${res.code}`);
    return res.stdout;
  };

  return {
    clone: (remoteUrl, localPath, branch, cred) =>
      exec(
        [...authArgs(cred), 'clone', ...(branch ? ['--branch', branch] : []), '--', remoteUrl, localPath],
        undefined,
        cred?.token
      ),

    status: async (localPath): Promise<GitRepoStatus> => {
      try {
        // Branch + upstream tracking in one shot.
        const branchRaw = await read(['rev-parse', '--abbrev-ref', 'HEAD'], localPath).catch(() => '');
        const branch = branchRaw.trim() || null;
        const porcelain = await read(['status', '--porcelain=v1'], localPath);
        const changedCount = porcelain.split('\n').filter((l) => l.trim().length > 0).length;
        const hasRemote = (await read(['remote'], localPath).catch(() => '')).trim().length > 0;
        // ahead/behind vs upstream (0/0 when no upstream).
        let ahead = 0;
        let behind = 0;
        const counts = await read(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], localPath).catch(
          () => ''
        );
        const m = counts.trim().split(/\s+/);
        if (m.length === 2) {
          behind = Number(m[0]) || 0;
          ahead = Number(m[1]) || 0;
        }
        return { isRepo: true, branch, changedCount, ahead, behind, hasRemote };
      } catch {
        return { isRepo: false, branch: null, changedCount: 0, ahead: 0, behind: 0, hasRemote: false };
      }
    },

    changes: async (localPath): Promise<GitFileChange[]> => {
      const raw = await read(['status', '--porcelain=v1', '-z'], localPath).catch(() => '');
      const tokens = raw.split('\u0000').filter(Boolean);
      const out: GitFileChange[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const entry = tokens[i];
        if (entry.length < 3) continue;
        const xy = entry.slice(0, 2);
        const relPath = entry.slice(3).replace(/\\/g, '/');
        if (xy.startsWith('R')) i += 1; // rename: skip the old-path token
        const x = xy[0];
        const y = xy[1];
        let status: GitFileChange['status'] = '?';
        let staged = false;
        if (x === '?' && y === '?') {
          status = 'U';
        } else {
          const wt = y === 'M' ? 'M' : y === 'A' ? 'A' : y === 'D' ? 'D' : y === 'R' ? 'R' : '?';
          if (wt !== '?') {
            status = wt;
            staged = x !== ' ' && x !== '?';
          } else {
            status = x === 'M' ? 'M' : x === 'A' ? 'A' : x === 'D' ? 'D' : x === 'R' ? 'R' : '?';
            staged = true;
          }
        }
        out.push({ path: relPath, status, staged });
      }
      return out;
    },

    log: async (localPath, limit = 30): Promise<GitCommit[]> => {
      // Use a NUL/RS-delimited format so subjects with any char round-trip.
      const fmt = '%h%x1f%s%x1f%an%x1f%cr';
      const raw = await read(['log', `-${limit}`, `--pretty=format:${fmt}`], localPath).catch(() => '');
      return raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((line) => {
          const [hash, subject, author, date] = line.split('\u001f');
          return { hash: hash ?? '', subject: subject ?? '', author: author ?? '', date: date ?? '' };
        });
    },

    commitAll: async (localPath, message, author) => {
      const staged = await exec(['add', '-A'], localPath);
      if (!staged.ok) return staged;
      const cfg = author ? ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`] : [];
      return exec([...cfg, 'commit', '-m', message], localPath);
    },

    push: async (localPath, branch, cred) =>
      exec([...authArgs(cred), 'push', '--set-upstream', 'origin', branch], localPath, cred?.token),

    pull: async (localPath, branch, cred) =>
      exec([...authArgs(cred), 'pull', '--no-rebase', 'origin', branch], localPath, cred?.token),

    initAndSetRemote: async (localPath, remoteUrl, branch) => {
      const init = await exec(['init', '-b', branch], localPath);
      if (!init.ok) {
        // Older git without -b: init then rename the branch.
        const plainInit = await exec(['init'], localPath);
        if (!plainInit.ok) return plainInit;
        await exec(['checkout', '-B', branch], localPath);
      }
      // Set origin (remove an existing one first so re-register is idempotent).
      await exec(['remote', 'remove', 'origin'], localPath);
      return exec(['remote', 'add', 'origin', remoteUrl], localPath);
    },
  };
};
