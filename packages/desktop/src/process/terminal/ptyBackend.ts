/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pseudo-terminal backend abstraction for the Terminal manager.
 *
 * The manager talks to an {@link IPtyBackend} rather than to `child_process`
 * directly, so the spawn mechanism is swappable and unit-testable:
 *
 *  - {@link createChildProcessBackend} (FALLBACK) spawns a real shell with
 *    Node's `child_process` and pipes stdio. This needs NO native compilation,
 *    works on every platform the app ships to, and gives a genuinely
 *    interactive shell (gõ lệnh, nhận output). It does NOT allocate a real TTY,
 *    so full-screen curses apps (vim, htop) and some color/`isatty` checks may
 *    behave differently than a hardware terminal. Used only when node-pty's
 *    native module cannot be loaded.
 *  - {@link createNodePtyBackend} (DEFAULT, see `nodePtyBackend.ts`) spawns the
 *    shell inside a real OS pty (ConPTY / forkpty) for full TTY fidelity
 *    (resize, signals, TUIs) — matching VS Code's integrated terminal. It
 *    satisfies the same {@link IPtyBackend} interface, so the manager is
 *    unchanged; `terminalWiring.ts` prefers it and falls back to the
 *    child_process backend if the native module is unavailable.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { type ChildProcessWithoutNullStreams, spawn as spawnProcess } from 'node:child_process';
import * as os from 'node:os';

/** A spawned shell process the manager can write to, resize, and kill. */
export type PtyProcess = {
  /** OS process id, or undefined if the spawn failed synchronously. */
  readonly pid: number | undefined;
  /** Write raw bytes to the shell's stdin (what the user types). */
  write(data: string): void;
  /** Best-effort resize (no-op for the child_process backend). */
  resize(cols: number, rows: number): void;
  /** Terminate the shell (and its tree where possible). */
  kill(signal?: NodeJS.Signals): void;
  /** Register the merged stdout+stderr data handler. */
  onData(listener: (chunk: string) => void): void;
  /** Register the exit handler (fires once). */
  onExit(listener: (exitCode: number | null) => void): void;
};

/** Parameters for spawning a shell. */
export type PtySpawnOptions = {
  /** Shell executable to run. */
  shell: string;
  /**
   * Explicit argv for the shell. When provided it OVERRIDES the backend's
   * default interactive args (used for shell profiles + shell-integration
   * launch). When omitted the backend derives sensible interactive args.
   */
  args?: string[];
  /** Working directory. */
  cwd: string;
  /** Full environment for the child. */
  env: Record<string, string>;
  /** Initial columns (advisory). */
  cols: number;
  /** Initial rows (advisory). */
  rows: number;
};

/** A backend that can spawn {@link PtyProcess} shells. */
export type IPtyBackend = {
  spawn(options: PtySpawnOptions): PtyProcess;
};

/**
 * Resolve the user's default interactive shell for the current platform.
 *  - Windows: `%COMSPEC%` (usually `cmd.exe`).
 *  - POSIX: `$SHELL`, falling back to `/bin/bash` then `/bin/sh`.
 */
export const resolveDefaultShell = (): string => {
  if (process.platform === 'win32') {
    return process.env.COMSPEC ?? 'cmd.exe';
  }
  return process.env.SHELL ?? '/bin/bash';
};

/**
 * Build the argv that keeps the shell open as an interactive session reading
 * from the piped stdin. POSIX shells take `-i`; cmd.exe uses `/Q` (echo off)
 * and PowerShell reads commands from stdin by default.
 */
const interactiveArgs = (shell: string): string[] => {
  const base = shell.toLowerCase();
  if (process.platform === 'win32') {
    if (base.includes('powershell') || base.includes('pwsh')) return ['-NoLogo', '-NoExit', '-Command', '-'];
    // cmd.exe: /Q disables command echo; /K keeps the shell alive after commands.
    return ['/Q', '/K'];
  }
  // POSIX interactive shell.
  return ['-i'];
};

/**
 * Best-effort process-tree termination. A plain ChildProcess.kill() often stops
 * only the shell, leaving the active command alive (common with long searches).
 */
export const killProcessTree = (pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): void => {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnProcess('taskkill', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', (error) => {
        console.error('[ptyBackend] taskkill failed:', error);
      });
      return;
    }
    process.kill(-pid, signal);
  } catch (error) {
    console.error('[ptyBackend] process-tree kill failed:', error);
  }
};

/** Default backend: a piped {@link ChildProcessWithoutNullStreams} shell. */
export const createChildProcessBackend = (): IPtyBackend => ({
  spawn({ shell, args, cwd, env }: PtySpawnOptions): PtyProcess {
    const child: ChildProcessWithoutNullStreams = spawnProcess(shell, args ?? interactiveArgs(shell), {
      cwd,
      env,
      detached: process.platform !== 'win32',
      // No shell:true — we ARE the shell. windowsHide keeps a console from flashing.
      windowsHide: true,
    });

    let exited = false;
    const dataListeners = new Set<(chunk: string) => void>();
    const exitListeners = new Set<(code: number | null) => void>();
    const earlyData: string[] = [];

    const deliverData = (text: string): void => {
      if (dataListeners.size === 0) {
        earlyData.push(text);
        return;
      }
      for (const listener of dataListeners) {
        try {
          listener(text);
        } catch (error) {
          console.error('[ptyBackend] data listener threw:', error);
        }
      }
    };

    const emitData = (chunk: Buffer): void => {
      deliverData(chunk.toString('utf-8'));
    };

    child.stdout.on('data', emitData);
    child.stderr.on('data', emitData);

    const fireExit = (code: number | null): void => {
      if (exited) return;
      exited = true;
      for (const listener of exitListeners) {
        try {
          listener(code);
        } catch (error) {
          console.error('[ptyBackend] exit listener threw:', error);
        }
      }
    };

    child.on('exit', (code) => fireExit(code));
    child.on('error', (error) => {
      console.error('[ptyBackend] shell process error:', error);
      fireExit(null);
    });

    return {
      get pid() {
        return child.pid;
      },
      write(data: string): void {
        if (exited) return;
        try {
          child.stdin.write(data);
        } catch (error) {
          console.error('[ptyBackend] stdin write failed:', error);
        }
      },
      resize(): void {
        // child_process has no TTY to resize; no-op. A node-pty backend would
        // implement this. Apps relying on COLUMNS/LINES can read the env.
      },
      kill(signal?: NodeJS.Signals): void {
        if (exited) return;
        try {
          killProcessTree(child.pid, signal ?? 'SIGTERM');
          if (process.platform === 'win32') {
            const fallback = setTimeout(() => {
              if (!exited) child.kill(signal ?? 'SIGTERM');
            }, 750);
            fallback.unref?.();
            return;
          }
          child.kill(signal ?? 'SIGTERM');
        } catch (error) {
          console.error('[ptyBackend] kill failed:', error);
        }
      },
      onData(listener): void {
        dataListeners.add(listener);
        if (earlyData.length === 0) return;
        const pending = earlyData.splice(0, earlyData.length);
        for (const text of pending) {
          try {
            listener(text);
          } catch (error) {
            console.error('[ptyBackend] data listener threw:', error);
          }
        }
      },
      onExit(listener): void {
        exitListeners.add(listener);
      },
    };
  },
});

/** The home directory used as the default cwd for new sessions. */
export const defaultCwd = (): string => os.homedir();
