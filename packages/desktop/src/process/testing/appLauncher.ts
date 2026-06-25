/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `appLauncher` — optionally boots the web app under test before a web test runs
 * (Yêu cầu 2b — UX). Answers "how does it know how to start my app?": the user
 * (or agent) declares a working directory + a start command (e.g. `npm run dev`)
 * + the dev URL. The launcher spawns the command in that directory, waits until
 * the URL responds, then the test navigates to it; afterwards the spawned
 * process tree is always killed.
 *
 * When no `command` is given the launcher just probes the URL (so a server the
 * user already started is reused). When a `command` is given the spawned dev
 * server is owned by this launcher and torn down after the run.
 *
 * ## Security note
 *
 * The start command is executed in a shell exactly as the user typed it — this
 * is intentional (it is a local task runner, like an IDE "run" config) but means
 * the caller must treat it as trusted, user-entered input. The command is never
 * derived from page content or a model; only from the user's explicit config
 * (or an agent acting on the user's behalf).
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Socket } from 'node:net';
import type { AppUnderTest, ServiceReadiness, ServiceSpec } from './testingTypes';

export type { AppUnderTest };

/** A started (or reused) app: the ready URL + a teardown that stops what we started. */
export type RunningApp = {
  /** The URL the test should navigate to. */
  url: string;
  /** Stop the spawned process tree (no-op when nothing was spawned). */
  stop: () => Promise<void>;
};

/** Injectable seams so the launcher is unit-testable without spawning/fetching. */
export type AppLauncherDeps = {
  /** Spawns the start command; defaults to a shell `spawn`. */
  spawnProcess?: (command: string, cwd: string | undefined) => ChildProcess;
  /** Probes the URL once; resolves `true` when the server answers. Defaults to `fetch`. */
  probe?: (url: string) => Promise<boolean>;
  /** Probes a TCP port once; resolves `true` when a connection is accepted. Defaults to `net`. */
  probePort?: (port: number) => Promise<boolean>;
  /** Kills a spawned process tree by pid. Defaults to OS-specific kill. */
  killTree?: (child: ChildProcess) => void;
  /** Delay primitive. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock (ms). Defaults to `Date.now`. */
  now?: () => number;
};

/** Public contract of the app launcher. */
export type IAppLauncher = {
  /** Start (or reuse) the app and resolve once its URL responds. */
  start: (app: AppUnderTest) => Promise<RunningApp>;
};

/** Default poll interval while waiting for the dev server (ms). */
const POLL_INTERVAL_MS = 500;

/** Default ready timeout (ms). Dev servers (Vite/webpack) can take a while cold. */
const DEFAULT_READY_TIMEOUT_MS = 60_000;

/** Longer ready timeout (ms) for build-heavy commands (docker build, gradle, …). */
const BUILD_READY_TIMEOUT_MS = 300_000;

/** Commands that compile/pull images on first run and need more time to become ready. */
const BUILD_HEAVY = /\b(docker\s+compose|docker-compose|docker\s+build|gradle|mvn|cargo\s+build|\bbuild\b)/i;

/** Pick a readiness timeout: an explicit one, else longer for build-heavy commands. */
const resolveTimeout = (explicit: number | undefined, command: string): number => {
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  return BUILD_HEAVY.test(command) ? BUILD_READY_TIMEOUT_MS : DEFAULT_READY_TIMEOUT_MS;
};

/** Default shell spawn: runs `command` in `cwd` with the shell so `npm run dev` works. */
const defaultSpawn = (command: string, cwd: string | undefined): ChildProcess =>
  // `pipe` (not `ignore`) so log-based readiness can scan output; harmless otherwise.
  spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

/** Default URL probe: any HTTP response (even 404) means the server is up. */
const defaultProbe = async (url: string): Promise<boolean> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      await fetch(url, { method: 'GET', signal: controller.signal });
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
};

/** Default TCP-port probe: resolves `true` when a connection is accepted on 127.0.0.1:port. */
const defaultProbePort = (port: number): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const socket = new Socket();
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });

/** Default process-tree kill: `taskkill /T /F` on Windows, signal otherwise. */
const defaultKillTree = (child: ChildProcess): void => {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // Kill the whole tree — `npm run dev` spawns node/vite children.
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
};

/**
 * Create an {@link IAppLauncher}.
 *
 * @param deps Optional injected seams (spawn/probe/kill/sleep/now) for testing.
 * @returns A launcher that boots+waits or reuses the app under test.
 */
export const createAppLauncher = (deps: AppLauncherDeps = {}): IAppLauncher => {
  const spawnProcess = deps.spawnProcess ?? defaultSpawn;
  const probe = deps.probe ?? defaultProbe;
  const probePort = deps.probePort ?? defaultProbePort;
  const killTree = deps.killTree ?? defaultKillTree;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))));
  const now = deps.now ?? (() => Date.now());

  /** Poll `url` until it responds or the deadline passes. Throws on timeout. */
  const waitForUrl = async (url: string, timeoutMs: number): Promise<void> => {
    const deadline = now() + timeoutMs;
    for (;;) {
      if (await probe(url)) return;
      if (now() >= deadline) {
        throw new Error(`The app did not become reachable at ${url} within ${Math.round(timeoutMs / 1000)}s.`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  };

  /** Poll a TCP `port` until it accepts a connection or the deadline passes. */
  const waitForPort = async (port: number, timeoutMs: number): Promise<void> => {
    const deadline = now() + timeoutMs;
    for (;;) {
      if (await probePort(port)) return;
      if (now() >= deadline) {
        throw new Error(`Port ${port} did not open within ${Math.round(timeoutMs / 1000)}s.`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  };

  /**
   * Spawn one background service and wait for its readiness. Returns a `stop`
   * that kills the spawned tree. Throws (after stopping) if it crashes early or
   * never becomes ready.
   */
  const startService = async (service: ServiceSpec): Promise<{ stop: () => Promise<void> }> => {
    const timeoutMs = resolveTimeout(service.readyTimeoutMs, service.command);
    const label = service.name?.trim() || service.command.trim();
    const child = spawnProcess(service.command.trim(), service.cwd);

    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      killTree(child);
    };

    // Buffer recent output for log-based readiness + early-crash diagnostics.
    let logBuffer = '';
    const appendLog = (chunk: Buffer | string): void => {
      logBuffer = (logBuffer + String(chunk)).slice(-8192);
    };
    child.stdout?.on('data', appendLog);
    child.stderr?.on('data', appendLog);

    let earlyExit: string | undefined;
    child.once('exit', (code, signal) => {
      if (!stopped) earlyExit = `Service "${label}" exited early (code ${code ?? 'null'}, signal ${signal ?? 'null'}).`;
    });
    child.once('error', (error: Error) => {
      if (!stopped) earlyExit = `Service "${label}" failed to launch: ${error.message}`;
    });

    const ready: ServiceReadiness | undefined = service.ready;
    /** Resolve once the configured readiness condition is met (or immediately when none). */
    const awaitReady = async (): Promise<void> => {
      if (!ready) return; // fire-and-forget
      if (ready.type === 'url') return waitForUrl(ready.url, timeoutMs);
      if (ready.type === 'port') return waitForPort(ready.port, timeoutMs);
      if (ready.type === 'delay') return sleep(ready.ms);
      // log: scan buffered output for the match (substring, case-insensitive).
      const needle = ready.match.toLowerCase();
      const deadline = now() + timeoutMs;
      for (;;) {
        if (logBuffer.toLowerCase().includes(needle)) return;
        if (now() >= deadline) {
          throw new Error(`Service "${label}" did not log "${ready.match}" within ${Math.round(timeoutMs / 1000)}s.`);
        }
        await sleep(POLL_INTERVAL_MS);
      }
    };

    try {
      let readyDone = false;
      await Promise.race([
        awaitReady().then(() => {
          readyDone = true;
        }),
        (async () => {
          while (!readyDone && earlyExit === undefined) await sleep(POLL_INTERVAL_MS);
          if (earlyExit !== undefined) throw new Error(earlyExit);
        })(),
      ]);
    } catch (error) {
      await stop();
      throw error;
    }

    return { stop };
  };

  const start = async (app: AppUnderTest): Promise<RunningApp> => {
    const timeoutMs = resolveTimeout(app.readyTimeoutMs, app.command ?? '');

    // 1) Start prerequisite services (backend, db, workers) in order. Each is
    //    waited on per its readiness; a failure stops everything started so far.
    const started: Array<{ stop: () => Promise<void> }> = [];
    /** Stop every started service (the app + prerequisites) in reverse order. */
    const stopAll = async (): Promise<void> => {
      for (const s of [...started].toReversed()) await s.stop().catch((): undefined => undefined);
    };

    try {
      for (const service of app.services ?? []) {
        const running = await startService(service);
        started.push(running);
      }
    } catch (error) {
      await stopAll();
      throw error;
    }

    // No URL declared (e.g. a non-web app, or services-only) → nothing to probe.
    const url = app.url?.trim() ?? '';
    if (url.length === 0) {
      return { url: '', stop: stopAll };
    }

    // 2) Start (or reuse) the main app. No command → assume already running and
    //    just confirm the URL answers.
    if (!app.command || app.command.trim().length === 0) {
      try {
        await waitForUrl(url, timeoutMs);
      } catch (error) {
        await stopAll();
        throw error;
      }
      return { url, stop: stopAll };
    }

    const child = spawnProcess(app.command.trim(), app.cwd);
    let appStopped = false;
    started.push({
      stop: async (): Promise<void> => {
        if (appStopped) return;
        appStopped = true;
        killTree(child);
      },
    });

    // Capture the app's terminal output so a failure can SHOW why (e.g. "docker:
    // command not found", "port in use"), instead of a blind timeout. This is
    // what the user/agent would otherwise read in a terminal.
    let appLog = '';
    const appendAppLog = (chunk: Buffer | string): void => {
      appLog = (appLog + String(chunk)).slice(-4096);
    };
    child.stdout?.on('data', appendAppLog);
    child.stderr?.on('data', appendAppLog);
    /** Trailing terminal output, trimmed for an error message. */
    const tailLog = (): string => {
      const text = appLog.trim();
      if (!text) return '';
      const tail = text.split('\n').slice(-12).join('\n');
      return `\n\nLast output from \`${app.command?.trim()}\`:\n${tail}`;
    };

    // If the dev server dies before becoming ready, fail fast with its exit info.
    let earlyExit: string | undefined;
    child.once('exit', (code, signal) => {
      if (!appStopped)
        earlyExit = `The start command exited early (code ${code ?? 'null'}, signal ${signal ?? 'null'}).${tailLog()}`;
    });
    child.once('error', (error: Error) => {
      if (!appStopped) earlyExit = `The start command failed to launch: ${error.message}${tailLog()}`;
    });

    try {
      let urlReady = false;
      await Promise.race([
        waitForUrl(url, timeoutMs).then(() => {
          urlReady = true;
        }),
        // Surface an early crash promptly instead of waiting the full timeout.
        (async () => {
          while (!urlReady && earlyExit === undefined) await sleep(POLL_INTERVAL_MS);
          if (earlyExit !== undefined) throw new Error(earlyExit);
        })(),
      ]);
    } catch (error) {
      await stopAll();
      // On a plain URL timeout, attach whatever the command printed so the user
      // can see what happened (the app may be running but on a different port).
      const base = error instanceof Error ? error.message : String(error);
      const withLog = /Last output from/.test(base) ? base : `${base}${tailLog()}`;
      throw new Error(withLog, { cause: error });
    }

    return { url, stop: stopAll };
  };

  return { start };
};
