/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Terminal session manager — the Main-process registry of app-managed shells.
 *
 * Owns a map of live {@link TerminalSession}s, each backed by an
 * {@link IPtyBackend} process. Responsibilities:
 *  - create / write / resize / kill sessions,
 *  - keep a bounded scrollback buffer per session so a renderer that (re)opens
 *    the Terminal page can replay recent output instead of seeing a blank pane,
 *  - emit `data` / `exit` / `sessions-changed` so the bridge can stream to the
 *    renderer,
 *  - count app-managed sessions (the "how many terminals are running" number).
 *
 * The backend, clock, and id generator are injectable for unit tests (no real
 * shells needed).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';
import {
  createChildProcessBackend,
  defaultCwd,
  type IPtyBackend,
  type PtyProcess,
  resolveDefaultShell,
} from './ptyBackend';
import { buildIntegratedLaunch } from './shellIntegration';
import { resolveMtuiPath } from './mtuiBridge';
import type { CreateTerminalOptions, TerminalSession } from './terminalTypes';

/** Max characters of scrollback retained per session for replay-on-attach. */
const SCROLLBACK_LIMIT = 200_000;

export const withMtuiPathEnv = (
  baseEnv: Record<string, string>,
  mtuiPath = resolveMtuiPath()
): Record<string, string> => {
  const pathKey =
    process.platform === 'win32'
      ? (Object.keys(baseEnv).find((key) => key.toLowerCase() === 'path') ?? 'Path')
      : 'PATH';
  const currentPath = baseEnv[pathKey] ?? '';
  const mtuiDir = dirname(mtuiPath);
  const existingParts = currentPath.split(delimiter).filter((part) => part.length > 0);
  const hasMtuiDir = existingParts.some((part) =>
    process.platform === 'win32' ? part.toLowerCase() === mtuiDir.toLowerCase() : part === mtuiDir
  );
  const nextPath = hasMtuiDir ? currentPath : [mtuiDir, currentPath].filter(Boolean).join(delimiter);
  return {
    ...baseEnv,
    [pathKey]: nextPath,
    MTUI_BIN: mtuiPath,
  };
};

/** Injected dependencies for {@link createTerminalManager}. */
export type TerminalManagerDeps = {
  /** PTY backend. Defaults to the child_process shell backend. */
  backend?: IPtyBackend;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Id generator. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
};

/** Events emitted by the manager (consumed by the bridge). */
export type TerminalManagerEvents = {
  data: (event: { id: string; data: string }) => void;
  exit: (event: { id: string; exitCode: number | null; exitedAt: number }) => void;
  'sessions-changed': (sessions: TerminalSession[]) => void;
};

/** A live session plus its private runtime handles (not exposed to renderer). */
type LiveSession = {
  meta: TerminalSession;
  proc: PtyProcess;
  /** Bounded scrollback for replay on attach. */
  scrollback: string;
  /** Temp files (shell-integration rc files) to delete when the session exits. */
  tempFiles: string[];
};

/** Public contract of the terminal manager. */
export type ITerminalManager = {
  /** Create + start a new session. Returns its metadata snapshot. */
  create(options?: CreateTerminalOptions): TerminalSession;
  /** Write user input to a session's stdin. */
  write(id: string, data: string): void;
  /** Best-effort resize. */
  resize(id: string, cols: number, rows: number): void;
  /** Kill a session's process. The session stays listed as `exited`. */
  kill(id: string): void;
  /** Remove an exited session from the registry. Running sessions are killed first. */
  remove(id: string): void;
  /** Snapshot metadata for every session (running + recently exited). */
  list(): TerminalSession[];
  /** Count of sessions currently `running`. */
  runningCount(): number;
  /** Replay buffer for a session (recent output), or '' if unknown. */
  getScrollback(id: string): string;
  /** Subscribe to a manager event. Returns an unsubscribe fn. */
  on<E extends keyof TerminalManagerEvents>(event: E, listener: TerminalManagerEvents[E]): () => void;
  /** Kill every session (app shutdown). */
  dispose(): void;
};

/**
 * Create a terminal manager. Production callers use the default backend; tests
 * inject a fake backend to drive data/exit deterministically.
 */
export const createTerminalManager = (deps: TerminalManagerDeps = {}): ITerminalManager => {
  const backend = deps.backend ?? createChildProcessBackend();
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const emitter = new EventEmitter();
  const sessions = new Map<string, LiveSession>();
  /** Monotonic counter for default titles ("cmd 1", "bash 2", …). */
  let counter = 0;

  const snapshot = (): TerminalSession[] => Array.from(sessions.values(), (s) => ({ ...s.meta }));

  const emitSessionsChanged = (): void => {
    emitter.emit('sessions-changed', snapshot());
  };

  const shellBaseName = (shell: string): string => {
    const parts = shell.split(/[/\\]/);
    const base = parts[parts.length - 1] ?? shell;
    return base.replace(/\.exe$/i, '');
  };

  const appendScrollback = (live: LiveSession, chunk: string): void => {
    const combined = live.scrollback + chunk;
    live.scrollback =
      combined.length > SCROLLBACK_LIMIT ? combined.slice(combined.length - SCROLLBACK_LIMIT) : combined;
  };

  /** Delete a session's shell-integration temp files (rc files), best-effort. */
  const cleanupTempFiles = (live: LiveSession): void => {
    for (const file of live.tempFiles) {
      try {
        rmSync(file, { force: true });
        // Also remove the temp dir we created for it (mkdtemp parent).
        rmSync(dirname(file), { recursive: true, force: true });
      } catch {
        // Best-effort; OS will reap tmpdir eventually.
      }
    }
    live.tempFiles = [];
  };

  const create = (options: CreateTerminalOptions = {}): TerminalSession => {
    const id = newId();
    const shell = options.shell && options.shell.trim().length > 0 ? options.shell : resolveDefaultShell();
    const cwd = options.cwd && options.cwd.trim().length > 0 ? options.cwd : defaultCwd();
    counter += 1;
    const title =
      options.title && options.title.trim().length > 0 ? options.title : `${shellBaseName(shell)} ${counter}`;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...options.env,
      // Hint terminal-aware tools that ANSI color is acceptable.
      TERM: process.env.TERM ?? 'xterm-256color',
      COLORTERM: process.env.COLORTERM ?? 'truecolor',
    };

    // Wire VS Code-style shell integration (OSC 633 command decorations) via the
    // shell's startup mechanism (rc file / launch args), unless disabled or this
    // is a scheduled script run (which wants a pristine prompt).
    const integrate = options.noShellIntegration !== true && options.scheduled !== true;
    const launch = integrate
      ? buildIntegratedLaunch(shell, options.args)
      : { shell, args: options.args, env: undefined, tempFiles: [] as string[] };
    if (launch.env) Object.assign(env, launch.env);
    const finalEnv = withMtuiPathEnv(env);

    const proc = backend.spawn({
      shell,
      args: launch.args,
      cwd,
      env: finalEnv,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    });

    const meta: TerminalSession = {
      id,
      title,
      shell,
      cwd,
      status: 'running',
      createdAt: now(),
      exitedAt: null,
      exitCode: null,
      pid: proc.pid ?? null,
      scheduled: options.scheduled === true,
    };

    const live: LiveSession = { meta, proc, scrollback: '', tempFiles: launch.tempFiles };
    sessions.set(id, live);

    proc.onData((chunk) => {
      appendScrollback(live, chunk);
      emitter.emit('data', { id, data: chunk });
    });

    proc.onExit((exitCode) => {
      const exitedAt = now();
      live.meta.status = 'exited';
      live.meta.exitedAt = exitedAt;
      live.meta.exitCode = exitCode;
      cleanupTempFiles(live);
      emitter.emit('exit', { id, exitCode, exitedAt });
      emitSessionsChanged();
    });

    emitSessionsChanged();
    return { ...meta };
  };

  const write = (id: string, data: string): void => {
    sessions.get(id)?.proc.write(data);
  };

  const resize = (id: string, cols: number, rows: number): void => {
    sessions.get(id)?.proc.resize(cols, rows);
  };

  const kill = (id: string): void => {
    const live = sessions.get(id);
    if (!live || live.meta.status === 'exited') return;
    live.proc.kill();
  };

  const remove = (id: string): void => {
    const live = sessions.get(id);
    if (!live) return;
    if (live.meta.status !== 'exited') live.proc.kill();
    sessions.delete(id);
    emitSessionsChanged();
  };

  return {
    create,
    write,
    resize,
    kill,
    remove,
    list: snapshot,
    runningCount: () => Array.from(sessions.values()).filter((s) => s.meta.status === 'running').length,
    getScrollback: (id) => sessions.get(id)?.scrollback ?? '',
    on(event, listener) {
      emitter.on(event as string, listener as (...args: unknown[]) => void);
      return () => emitter.off(event as string, listener as (...args: unknown[]) => void);
    },
    dispose() {
      for (const live of sessions.values()) {
        if (live.meta.status !== 'exited') live.proc.kill();
        cleanupTempFiles(live);
      }
      sessions.clear();
      emitter.removeAllListeners();
    },
  };
};
