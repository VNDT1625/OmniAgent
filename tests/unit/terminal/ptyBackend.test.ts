/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { killProcessTree } from '@/process/terminal/ptyBackend';

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
});
