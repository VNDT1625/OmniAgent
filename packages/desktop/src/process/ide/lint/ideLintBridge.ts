/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IDE Lint IPC bridge — runs oxlint on ONE file and returns structured
 * diagnostics so the Monaco editor can paint inline squiggles (the "diagnostics
 * inline" IDE feature). oxlint is fast (Rust), already a project dependency, and
 * has a stable `--format unix` output that {@link parseUnixLint} turns into
 * {@link LintDiagnostic}s.
 *
 * One channel: `ide.lint-file` — given an absolute file path + the repo root,
 * spawn `oxlint --format unix <file>` with the repo as cwd (so its config and
 * tsconfig resolution work) and parse the result. Always-resolving envelope so
 * the renderer never hangs; an absent/odd oxlint just yields no diagnostics.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { parseUnixLint, type LintDiagnostic } from './lintParse';

/** IPC channel names for the IDE lint surface (renderer-safe contract). */
export const IDE_LINT_CHANNELS = {
  lintFile: 'ide.lint-file',
} as const;

/** Always-resolving result envelope. */
export type IdeLintResult = { ok: true; data: LintDiagnostic[] } | { ok: false; error: string };

/** Request for {@link IDE_LINT_CHANNELS.lintFile}. */
export type LintFileRequest = {
  /** Absolute path of the file to lint. */
  filePath: string;
  /** Absolute repo root (oxlint cwd). Optional — auto-detected from the file when absent. */
  rootPath?: string;
};

/** Typed channel. Exported for bootstrap registration wiring. */
export const ideLintChannels = {
  lintFile: bridge.buildProvider<IdeLintResult, LintFileRequest>(IDE_LINT_CHANNELS.lintFile),
};

/** File extensions oxlint can lint (others return no diagnostics quickly). */
const LINTABLE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/** Spawn function (injectable for tests). Resolves stdout regardless of exit code. */
export type LintSpawn = (file: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

const defaultSpawn: LintSpawn = (file, args, cwd) =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 * 8 }, (error, stdout) => {
      const code =
        error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : error
            ? 1
            : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });

/** Resolve the oxlint binary command. On Windows the npm bin is `oxlint.cmd`. */
const oxlintBin = (rootPath: string): { file: string; baseArgs: string[] } => {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const local = path.join(rootPath, 'node_modules', '.bin', `oxlint${ext}`);
  return { file: local, baseArgs: ['--format', 'unix'] };
};

/**
 * Find the repo root for a file: walk up until a directory has `package.json`
 * (or an oxlint config). Falls back to the file's own directory.
 */
const detectRoot = (filePath: string): string => {
  let dir = path.dirname(filePath);
  for (let i = 0; i < 30; i++) {
    if (
      existsSync(path.join(dir, 'package.json')) ||
      existsSync(path.join(dir, '.oxlintrc.json')) ||
      existsSync(path.join(dir, 'node_modules'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(filePath);
};

/** Dependencies for {@link createLintFile} (injectable for tests). */
export type LintDeps = { spawn?: LintSpawn };

/** Build the lint-one-file function. */
export const createLintFile = (deps: LintDeps = {}) => {
  const spawn = deps.spawn ?? defaultSpawn;
  return async (req: LintFileRequest): Promise<LintDiagnostic[]> => {
    const filePath = req.filePath?.trim();
    if (!filePath) return [];
    if (!LINTABLE.has(path.extname(filePath).toLowerCase())) return [];
    const rootPath = req.rootPath?.trim() || detectRoot(filePath);
    const { file, baseArgs } = oxlintBin(rootPath);
    const { stdout } = await spawn(file, [...baseArgs, filePath], rootPath);
    // oxlint exits 1 when it found lint problems — that's expected, not a failure.
    return parseUnixLint(stdout, 'warning');
  };
};

/**
 * Register the IDE lint IPC handler. Idempotent. Intended to be called once
 * during Main-process bootstrap.
 */
export function registerIdeLintBridge(): void {
  const lintFile = createLintFile();
  ideLintChannels.lintFile.provider(async (req): Promise<IdeLintResult> => {
    try {
      return { ok: true, data: await lintFile(req) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
