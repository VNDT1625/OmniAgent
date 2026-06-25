/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/terminal/terminalManager — the app-managed session
 * registry. Uses a fake PTY backend so no real shells are spawned: it lets the
 * test drive data/exit deterministically and assert lifecycle + scrollback +
 * event emission + running-count behaviour.
 */

import { describe, expect, it, vi } from 'vitest';
import { delimiter, dirname } from 'node:path';
import type { IPtyBackend, PtyProcess, PtySpawnOptions } from '@/process/terminal/ptyBackend';
import { createTerminalManager, withMtuiPathEnv } from '@/process/terminal/terminalManager';

/** A controllable fake PTY process the test can push data into / exit. */
type FakeProc = PtyProcess & {
  emitData: (chunk: string) => void;
  emitExit: (code: number | null) => void;
  written: string[];
  killed: boolean;
};

const makeBackend = (): { backend: IPtyBackend; procs: FakeProc[] } => {
  const procs: FakeProc[] = [];
  const backend: IPtyBackend = {
    spawn(_options: PtySpawnOptions): PtyProcess {
      const dataListeners = new Set<(c: string) => void>();
      const exitListeners = new Set<(c: number | null) => void>();
      const proc: FakeProc = {
        pid: 1000 + procs.length,
        written: [],
        killed: false,
        write(data) {
          this.written.push(data);
        },
        resize() {},
        kill() {
          this.killed = true;
          for (const l of exitListeners) l(0);
        },
        onData(l) {
          dataListeners.add(l);
        },
        onExit(l) {
          exitListeners.add(l);
        },
        emitData(chunk) {
          for (const l of dataListeners) l(chunk);
        },
        emitExit(code) {
          for (const l of exitListeners) l(code);
        },
      };
      procs.push(proc);
      return proc;
    },
  };
  return { backend, procs };
};

describe('terminalManager', () => {
  it('creates a running session and reports it in list + runningCount', () => {
    const { backend } = makeBackend();
    const mgr = createTerminalManager({ backend, now: () => 1, newId: () => 'id-1' });

    const session = mgr.create({ shell: '/bin/bash', cwd: '/home/me' });

    expect(session.id).toBe('id-1');
    expect(session.status).toBe('running');
    expect(session.shell).toBe('/bin/bash');
    expect(session.cwd).toBe('/home/me');
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.runningCount()).toBe(1);
  });

  it('adds MTUI to terminal environment path', () => {
    const mtuiPath =
      process.platform === 'win32' ? 'C:\\Users\\me\\AppData\\Local\\mtui\\mtui.exe' : '/home/me/.local/bin/mtui';
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    const env = withMtuiPathEnv({ [pathKey]: 'existing-path' }, mtuiPath);

    expect(env.MTUI_BIN).toBe(mtuiPath);
    expect(env[pathKey]?.split(delimiter)[0]).toBe(dirname(mtuiPath));
  });

  it('buffers output as scrollback and emits data events', () => {
    const { backend, procs } = makeBackend();
    const mgr = createTerminalManager({ backend });
    const onData = vi.fn();
    mgr.on('data', onData);

    const session = mgr.create();
    procs[0].emitData('hello ');
    procs[0].emitData('world');

    expect(mgr.getScrollback(session.id)).toBe('hello world');
    expect(onData).toHaveBeenCalledTimes(2);
    expect(onData).toHaveBeenLastCalledWith({ id: session.id, data: 'world' });
  });

  it('forwards user input to the backend process stdin', () => {
    const { backend, procs } = makeBackend();
    const mgr = createTerminalManager({ backend });
    const session = mgr.create();

    mgr.write(session.id, 'ls -la\n');

    expect(procs[0].written).toEqual(['ls -la\n']);
  });

  it('marks a session exited and emits exit + sessions-changed', () => {
    const { backend, procs } = makeBackend();
    const mgr = createTerminalManager({ backend, now: () => 42 });
    const onExit = vi.fn();
    const onChanged = vi.fn();
    mgr.on('exit', onExit);
    mgr.on('sessions-changed', onChanged);

    const session = mgr.create();
    procs[0].emitExit(0);

    const updated = mgr.list().find((s) => s.id === session.id)!;
    expect(updated.status).toBe('exited');
    expect(updated.exitCode).toBe(0);
    expect(updated.exitedAt).toBe(42);
    expect(mgr.runningCount()).toBe(0);
    expect(onExit).toHaveBeenCalledWith({ id: session.id, exitCode: 0, exitedAt: 42 });
    expect(onChanged).toHaveBeenCalled();
  });

  it('kill terminates a running session but keeps it listed as exited', () => {
    const { backend, procs } = makeBackend();
    const mgr = createTerminalManager({ backend });
    const session = mgr.create();

    mgr.kill(session.id);

    expect(procs[0].killed).toBe(true);
    expect(mgr.list().find((s) => s.id === session.id)?.status).toBe('exited');
  });

  it('remove deletes a session from the registry', () => {
    const { backend } = makeBackend();
    const mgr = createTerminalManager({ backend });
    const session = mgr.create();

    mgr.remove(session.id);

    expect(mgr.list()).toHaveLength(0);
  });

  it('dispose kills every running session and clears the registry', () => {
    const { backend, procs } = makeBackend();
    const mgr = createTerminalManager({ backend });
    mgr.create();
    mgr.create();

    mgr.dispose();

    expect(procs.every((p) => p.killed)).toBe(true);
    expect(mgr.list()).toHaveLength(0);
  });
});
