/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChildProcessBackend, killProcessTree } from '@/process/terminal/ptyBackend';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ on: vi.fn() })),
}));

const originalPlatform = process.platform;

const setPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
};

const makeFakeChild = () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn> };
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = { write: vi.fn() };
  child.pid = 1234;
  child.kill = vi.fn();
  return child;
};

describe('ptyBackend', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    });
    vi.restoreAllMocks();
  });

  it('kills the full process tree with taskkill on Windows', () => {
    setPlatform('win32');

    killProcessTree(1234);

    expect(spawn).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  });

  it('kills the process group on POSIX', () => {
    setPlatform('linux');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    killProcessTree(1234, 'SIGTERM');

    expect(kill).toHaveBeenCalledWith(-1234, 'SIGTERM');
  });

  it('replays shell output emitted before the manager attaches a data listener', () => {
    const fakeChild = makeFakeChild();
    vi.mocked(spawn).mockReturnValueOnce(fakeChild as never);
    const proc = createChildProcessBackend().spawn({
      shell: 'cmd.exe',
      cwd: 'C:\\Users\\me',
      env: {},
      cols: 80,
      rows: 24,
    });

    fakeChild.stdout.emit('data', Buffer.from('Microsoft Windows\r\n'));
    fakeChild.stdout.emit('data', Buffer.from('C:\\Users\\me>'));
    const onData = vi.fn();
    proc.onData(onData);

    expect(onData).toHaveBeenCalledTimes(2);
    expect(onData).toHaveBeenNthCalledWith(1, 'Microsoft Windows\r\n');
    expect(onData).toHaveBeenNthCalledWith(2, 'C:\\Users\\me>');
  });
});
