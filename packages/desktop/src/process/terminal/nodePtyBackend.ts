/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `node-pty`-backed {@link IPtyBackend} — a REAL pseudo-terminal, matching the
 * fidelity of VS Code's integrated terminal.
 *
 * Unlike the {@link createChildProcessBackend} fallback (which only pipes stdio
 * and cannot allocate a TTY), this backend spawns the shell inside an OS pty
 * (ConPTY on Windows, forkpty on macOS/Linux). That gives:
 *  - `isatty()` true → tools enable colors/prompts/spinners as on a real term,
 *  - working `resize(cols, rows)` → line-wrapping and full-screen TUIs
 *    (vim, htop, lazygit) render correctly,
 *  - proper signal/job-control semantics.
 *
 * node-pty ships N-API prebuilds (ABI-stable across Node/Electron), so no
 * per-Electron native rebuild is required — it loads the same way `better-sqlite3`
 * already does in this app.
 *
 * Loading is defensive: {@link tryCreateNodePtyBackend} returns `null` if the
 * native module cannot be loaded (missing prebuild for the platform, etc.) so the
 * manager can fall back to the child_process backend instead of crashing.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { killProcessTree, type IPtyBackend, type PtyProcess, type PtySpawnOptions } from './ptyBackend';

/** Minimal shape of the node-pty module we rely on (avoids a hard type dep). */
type NodePtyModule = {
  spawn: (
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
      useConpty?: boolean;
    }
  ) => NodePtyProcess;
};

/** Minimal shape of a spawned node-pty process. */
type NodePtyProcess = {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
};

/**
 * Argv for an interactive login shell inside a real pty. With a TTY allocated we
 * do NOT need the `-i`/`/K` keep-alive tricks the piped backend uses — the pty
 * keeps the shell alive. PowerShell still wants -NoLogo for a clean prompt.
 */
const ptyShellArgs = (shell: string): string[] => {
  const base = shell.toLowerCase();
  if (process.platform === 'win32') {
    if (base.includes('powershell') || base.includes('pwsh')) return ['-NoLogo'];
    return []; // cmd.exe: the pty keeps it alive; no /K needed.
  }
  return ['-l']; // POSIX login shell.
};

/**
 * Build a node-pty backend. Throws if the native module fails to load — callers
 * should use {@link tryCreateNodePtyBackend} to get a safe nullable variant.
 */
export const createNodePtyBackend = (): IPtyBackend => {
  // Loaded lazily via require so a missing native binary throws here (caught by
  // tryCreateNodePtyBackend) rather than at import time.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pty = require('node-pty') as NodePtyModule;

  return {
    spawn({ shell, args, cwd, env, cols, rows }: PtySpawnOptions): PtyProcess {
      const proc = pty.spawn(shell, args ?? ptyShellArgs(shell), {
        name: env.TERM ?? 'xterm-256color',
        cols: cols > 0 ? cols : 80,
        rows: rows > 0 ? rows : 24,
        cwd,
        env,
      });

      let exited = false;
      const dataListeners = new Set<(chunk: string) => void>();
      const earlyData: string[] = [];

      const deliverData = (data: string): void => {
        if (dataListeners.size === 0) {
          earlyData.push(data);
          return;
        }
        for (const listener of dataListeners) {
          try {
            listener(data);
          } catch (error) {
            console.error('[nodePtyBackend] data listener threw:', error);
          }
        }
      };

      proc.onData(deliverData);

      return {
        get pid() {
          return proc.pid;
        },
        write(data: string): void {
          if (exited) return;
          try {
            proc.write(data);
          } catch (error) {
            console.error('[nodePtyBackend] write failed:', error);
          }
        },
        resize(nextCols: number, nextRows: number): void {
          if (exited) return;
          try {
            proc.resize(Math.max(1, Math.floor(nextCols)), Math.max(1, Math.floor(nextRows)));
          } catch (error) {
            // A resize after the process is tearing down can throw on Windows;
            // it is harmless, so swallow it.
            console.error('[nodePtyBackend] resize failed:', error);
          }
        },
        kill(signal?: NodeJS.Signals): void {
          if (exited) return;
          try {
            killProcessTree(proc.pid, signal ?? 'SIGTERM');
            if (process.platform === 'win32') {
              const fallback = setTimeout(() => {
                if (!exited) proc.kill(signal);
              }, 750);
              fallback.unref?.();
              return;
            }
            // node-pty's Windows backend ignores the signal arg; POSIX honours it.
            proc.kill(signal);
          } catch (error) {
            console.error('[nodePtyBackend] kill failed:', error);
          }
        },
        onData(listener): void {
          dataListeners.add(listener);
          if (earlyData.length === 0) return;
          const pending = earlyData.splice(0, earlyData.length);
          for (const data of pending) {
            try {
              listener(data);
            } catch (error) {
              console.error('[nodePtyBackend] data listener threw:', error);
            }
          }
        },
        onExit(listener): void {
          proc.onExit(({ exitCode }) => {
            if (exited) return;
            exited = true;
            try {
              listener(exitCode);
            } catch (error) {
              console.error('[nodePtyBackend] exit listener threw:', error);
            }
          });
        },
      };
    },
  };
};

/**
 * Try to build a node-pty backend, returning `null` if the native module cannot
 * be loaded (so the manager can fall back to the child_process backend).
 */
export const tryCreateNodePtyBackend = (): IPtyBackend | null => {
  try {
    return createNodePtyBackend();
  } catch (error) {
    console.warn('[nodePtyBackend] node-pty unavailable; falling back to child_process backend:', error);
    return null;
  }
};
