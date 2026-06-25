/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ideGitBridge` — minimal Git inspection IPC bridge for the IDE workspace.
 *
 * The IDE Chat lets a CLI agent edit files directly on disk; without an in-app
 * review surface, the user has to bounce out to a separate Git tool to see what
 * changed. This bridge exposes just enough Git introspection (read-only) for the
 * IDE to render a diff-review banner + per-file diff modal:
 *
 *  - `ide.git-status` → list of changed/added/deleted files (relative paths)
 *    of a repo root, by parsing `git status --porcelain=v1 -z`.
 *  - `ide.git-diff`   → the full text diff (unified) of a single file vs HEAD,
 *    or the full new content for an unstaged new file.
 *
 * No write operations live here — accept/reject of an agent edit is handled in
 * the renderer by overwriting the working file with the edited text via the
 * existing `ide.write-file` channel; revert is `git checkout -- <file>` which we
 * also expose for convenience as `ide.git-revert-file`.
 *
 * `git` is invoked via `node:child_process.spawn` with the repo root as cwd, so
 * the user's `PATH` `git` is used (mirrors how a developer runs it). All
 * channels return an always-resolving envelope so the renderer never hangs even
 * if `git` is missing.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { spawn } from 'node:child_process';

/** IPC channel names for the IDE Git surface (renderer-safe contract). */
export const IDE_GIT_CHANNELS = {
  status: 'ide.git-status',
  diff: 'ide.git-diff',
  revertFile: 'ide.git-revert-file',
} as const;

/** Always-resolving result envelope (mirrors `IdeFileResult`). */
export type IdeGitResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** A single change reported by Git in a working-tree status. */
export type GitChange = {
  /** Relative path (forward-slash, against the repo root). */
  path: string;
  /**
   * Compressed status: M (modified), A (added/new), D (deleted), R (renamed),
   * U (untracked / new untracked file), `?` (unknown). Mirrors porcelain v1.
   */
  status: 'M' | 'A' | 'D' | 'R' | 'U' | '?';
  /** True when the change is in the staging area (index). */
  staged: boolean;
};

/** Request shapes. */
export type GitStatusRequest = { rootPath: string };
export type GitDiffRequest = { rootPath: string; relPath: string };
export type GitRevertRequest = { rootPath: string; relPath: string };

/** Typed channels. */
export const ideGitChannels = {
  status: bridge.buildProvider<IdeGitResult<GitChange[]>, GitStatusRequest>(IDE_GIT_CHANNELS.status),
  diff: bridge.buildProvider<IdeGitResult<string>, GitDiffRequest>(IDE_GIT_CHANNELS.diff),
  revertFile: bridge.buildProvider<IdeGitResult<boolean>, GitRevertRequest>(IDE_GIT_CHANNELS.revertFile),
};

/** Hard cap on a `git diff` payload to keep the renderer responsive. */
const MAX_DIFF_BYTES = 1_000_000; // ~1 MB

/**
 * Run `git` with the given args from `cwd` and resolve the captured stdout. On
 * a non-zero exit OR an OS-level spawn error, the returned promise REJECTS with
 * a descriptive error so the channel handler can surface it to the renderer.
 */
const runGit = (args: string[], cwd: string, byteCap = MAX_DIFF_BYTES): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let stderr = '';
    child.stdout.on('data', (buf: Buffer) => {
      if (truncated) return;
      total += buf.length;
      if (total > byteCap) {
        truncated = true;
        chunks.push(buf.subarray(0, Math.max(0, byteCap - (total - buf.length))));
        try {
          child.kill();
        } catch {
          /* best-effort */
        }
        return;
      }
      chunks.push(buf);
    });
    child.stderr.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf-8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0 || truncated) {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(truncated ? text + '\n[…diff truncated]' : text);
      } else {
        reject(new Error(stderr.trim() || `git exited with code ${code}`));
      }
    });
  });

/** Parse a single porcelain-v1 status entry's two-letter status code. */
const decodeStatus = (xy: string): { staged: boolean; status: GitChange['status'] } => {
  const x = xy[0]; // index status
  const y = xy[1]; // worktree status
  if (x === '?' && y === '?') return { staged: false, status: 'U' };
  // Worktree change wins for "what to review" UX; the staged column tells us
  // it is also staged. A pure-staged entry (Y === ' ') is reported as staged.
  const wt: GitChange['status'] = y === 'M' ? 'M' : y === 'A' ? 'A' : y === 'D' ? 'D' : y === 'R' ? 'R' : '?';
  if (wt !== '?') return { staged: x !== ' ' && x !== '?', status: wt };
  const idx: GitChange['status'] = x === 'M' ? 'M' : x === 'A' ? 'A' : x === 'D' ? 'D' : x === 'R' ? 'R' : '?';
  return { staged: true, status: idx };
};

/**
 * Parse `git status --porcelain=v1 -z` output into a list of changes. The `-z`
 * format separates entries with a NUL byte and uses NUL between the rename old
 * and new paths, so paths with spaces / quotes round-trip cleanly.
 */
const parseStatus = (raw: string): GitChange[] => {
  const out: GitChange[] = [];
  const tokens = raw.split('\u0000').filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (entry.length < 3) continue;
    const xy = entry.slice(0, 2);
    let relPath = entry.slice(3);
    if (xy.startsWith('R')) {
      // Rename: the next token is the OLD path; we keep the NEW path.
      i += 1;
    }
    relPath = relPath.replace(/\\/g, '/');
    const decoded = decodeStatus(xy);
    out.push({ path: relPath, status: decoded.status, staged: decoded.staged });
  }
  return out;
};

/**
 * Compute a diff for ONE file. Strategy:
 *  1. `git diff -- <file>` (unstaged changes against the index).
 *  2. If empty AND the file is staged: `git diff --cached -- <file>`.
 *  3. If empty AND the file is untracked: emit a synthetic "+" diff so the
 *     reviewer can still see the new content (mirrors how VS Code shows it).
 */
const computeFileDiff = async (rootPath: string, relPath: string): Promise<string> => {
  const unstaged = await runGit(['diff', '--no-color', '--', relPath], rootPath);
  if (unstaged.trim().length > 0) return unstaged;
  const staged = await runGit(['diff', '--cached', '--no-color', '--', relPath], rootPath);
  if (staged.trim().length > 0) return staged;
  // Untracked: render the file content as a synthetic add diff.
  try {
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const abs = path.resolve(rootPath, relPath);
    const text = await fsp.readFile(abs, 'utf-8');
    const lines = text.split('\n');
    const header = `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n`;
    return header + lines.map((l) => `+${l}`).join('\n');
  } catch {
    return '';
  }
};

/**
 * Register the IDE Git IPC handlers. Idempotent (re-registration replaces the
 * bound handlers). Called once during Main-process bootstrap.
 */
export function registerIdeGitBridge(): void {
  ideGitChannels.status.provider(async (req): Promise<IdeGitResult<GitChange[]>> => {
    try {
      const raw = await runGit(['status', '--porcelain=v1', '-z'], req.rootPath);
      return { ok: true, data: parseStatus(raw) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideGitChannels.diff.provider(async (req): Promise<IdeGitResult<string>> => {
    try {
      const text = await computeFileDiff(req.rootPath, req.relPath);
      return { ok: true, data: text };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideGitChannels.revertFile.provider(async (req): Promise<IdeGitResult<boolean>> => {
    try {
      // `--` separates the path from any flags so a file named like "-foo" is safe.
      await runGit(['checkout', '--', req.relPath], req.rootPath);
      return { ok: true, data: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
