/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `commandRunner` — the guarded shell escape-hatch behind the `ide_command`
 * agent tool.
 *
 * ## Why this exists
 *
 * The IDE plane gives an agent first-class tools for the common shell reflexes:
 * `ide_search` (grep), `ide_list_dir` (find/ls), `ide_read_file` (cat). But an
 * agent still legitimately needs to run *arbitrary* commands a dedicated tool
 * cannot model — `npm install`, `bun run build`, `git status`, a one-off script.
 * Without a sanctioned path for those, the agent falls back to a raw shell
 * (Bash) that bypasses the MTUI layer the user reviews AND can hang the session.
 *
 * This runner is that sanctioned path. It keeps the open-ended power of a shell
 * but removes the two failure modes of raw Bash:
 *
 *  1. **Hangs.** Every run has a hard timeout and runs with interactive prompts
 *     disabled, so a command that waits for input fails fast instead of blocking
 *     the agent forever.
 *  2. **Context floods.** Captured output is byte- and line-capped; the caller
 *     (the MCP tool) further runs it through the headroom/compactor layer, so a
 *     5000-line build log never dumps verbatim into the model's context.
 *
 * ## Statelessness & `cd`
 *
 * A shell `cd` mutates hidden session state, which an agent cannot see and which
 * makes runs non-reproducible. Instead of carrying a working directory across
 * calls, every run takes an explicit `cwd` (default: the repo root). To "cd into
 * abc then run x", the agent passes `cwd: "<root>/abc"`. The command string is
 * still run through a shell (so pipes / `&&` / globs work), but the *directory*
 * is an explicit, inspectable argument rather than invisible state.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { spawn } from 'node:child_process';

/** Captured result of one command invocation. */
export type CommandResult = {
  /** Exit code, or -1 when the process was killed (timeout) or never started. */
  code: number;
  /** Combined stdout (capped). */
  stdout: string;
  /** Combined stderr (capped). */
  stderr: string;
  /** True when the run was killed because it exceeded {@link CommandRunOptions.timeoutMs}. */
  timedOut: boolean;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
};

/** Options for a single {@link runCommand} invocation. */
export type CommandRunOptions = {
  /** Working directory for the command. Defaults to the caller-supplied root. */
  cwd?: string;
  /** Hard upper bound before the process is killed. Default 60_000 ms. */
  timeoutMs?: number;
  /** Max bytes captured PER stream before further output is dropped. Default 256 KB. */
  maxOutputBytes?: number;
  /** Extra environment variables merged on top of the inherited, prompt-disabled env. */
  env?: Record<string, string>;
};

/** Default per-run timeout — long enough for an install/build, short enough to not hang a session. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Default per-stream capture cap. */
const DEFAULT_MAX_OUTPUT_BYTES = 256_000;

/**
 * Environment that disables the common interactive prompts so a command fails
 * fast instead of blocking on stdin (which the agent can never satisfy).
 */
const NON_INTERACTIVE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  // npm / yarn / debian tooling: never stop to ask.
  npm_config_yes: 'true',
  CI: '1',
  DEBIAN_FRONTEND: 'noninteractive',
  // Disable pagers that would otherwise wait for a keypress.
  GIT_PAGER: 'cat',
  PAGER: 'cat',
};

/**
 * Injectable spawn seam so tests never shell out for real. Mirrors the pattern
 * used by `gitRunner`'s `GitSpawn`.
 */
export type CommandSpawn = (
  command: string,
  opts: Required<Omit<CommandRunOptions, 'env'>> & { env: NodeJS.ProcessEnv }
) => Promise<CommandResult>;

const defaultSpawn: CommandSpawn = (command, opts) =>
  new Promise<CommandResult>((resolve) => {
    const startedAt = Date.now();
    // Run through the platform shell so pipes / && / globs behave like a
    // developer's terminal. The command is a single string by design (this is
    // the "arbitrary command" hatch); structured tools cover the safe cases.
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      windowsHide: true,
      env: opts.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutTotal = 0;
    let stderrTotal = 0;
    let timedOut = false;

    const cap = (arr: Buffer[], total: number, buf: Buffer): number => {
      if (total >= opts.maxOutputBytes) return total;
      const remaining = opts.maxOutputBytes - total;
      arr.push(buf.length <= remaining ? buf : buf.subarray(0, remaining));
      return total + buf.length;
    };

    child.stdout?.on('data', (b: Buffer) => {
      stdoutTotal = cap(stdoutChunks, stdoutTotal, b);
    });
    child.stderr?.on('data', (b: Buffer) => {
      stderrTotal = cap(stderrChunks, stderrTotal, b);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first; the OS reclaims the tree on close. windowsHide + shell
      // means killing the shell terminates its children on close.
      child.kill('SIGTERM');
      // Hard stop if it ignores SIGTERM.
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, opts.timeoutMs);

    const finish = (code: number): void => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout: '',
        stderr: `Failed to start command: ${err instanceof Error ? err.message : String(err)}`,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on('close', (code) => finish(code ?? -1));
  });

/**
 * Run one shell command under the guard rails (timeout, output cap, prompts
 * disabled). Never rejects — failures and timeouts come back in the result so
 * the caller can render a clean message instead of crashing the tool.
 *
 * @param command The command line to run (a string; pipes/&&/globs allowed).
 * @param root    The repo root; used as the default cwd.
 * @param opts    Per-run overrides (cwd, timeout, output cap, extra env).
 * @param spawnFn Injected spawn (defaults to the real child_process spawn).
 */
export const runCommand = async (
  command: string,
  root: string,
  opts?: CommandRunOptions,
  spawnFn: CommandSpawn = defaultSpawn
): Promise<CommandResult> => {
  const trimmed = command?.trim();
  if (!trimmed) {
    return { code: -1, stdout: '', stderr: 'An empty command was provided.', timedOut: false, durationMs: 0 };
  }
  return spawnFn(trimmed, {
    cwd: opts?.cwd?.trim() || root,
    timeoutMs: opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS,
    maxOutputBytes: opts?.maxOutputBytes && opts.maxOutputBytes > 0 ? opts.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES,
    env: { ...process.env, ...NON_INTERACTIVE_ENV, ...opts?.env },
  });
};
