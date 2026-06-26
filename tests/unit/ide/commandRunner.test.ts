/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { runCommand, type CommandSpawn } from '@/process/ide/command/commandRunner';

describe('commandRunner', () => {
  it('passes the command and defaults cwd to the repo root', async () => {
    const spawn: CommandSpawn = vi.fn(async (command, opts) => ({
      code: 0,
      stdout: `ran: ${command} @ ${opts.cwd}`,
      stderr: '',
      timedOut: false,
      durationMs: 1,
    }));
    const result = await runCommand('echo hi', '/repo', undefined, spawn);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ran: echo hi @ /repo');
  });

  it('honours an explicit cwd over the root (no hidden cd state)', async () => {
    const spawn: CommandSpawn = vi.fn(async (_command, opts) => ({
      code: 0,
      stdout: opts.cwd,
      stderr: '',
      timedOut: false,
      durationMs: 1,
    }));
    const result = await runCommand('ls', '/repo', { cwd: '/repo/sub' }, spawn);
    expect(result.stdout).toBe('/repo/sub');
  });

  it('applies the default timeout and capacity, and disables interactive prompts', async () => {
    const spawn: CommandSpawn = vi.fn(async () => ({
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 1,
    }));
    await runCommand('git status', '/repo', undefined, spawn);
    const [, opts] = (spawn as unknown as { mock: { calls: [string, Parameters<CommandSpawn>[1]][] } }).mock.calls[0];
    expect(opts.timeoutMs).toBe(60_000);
    expect(opts.maxOutputBytes).toBe(256_000);
    expect(opts.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(opts.env.CI).toBe('1');
  });

  it('rejects an empty command cleanly instead of spawning', async () => {
    const spawn: CommandSpawn = vi.fn(async () => ({
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 1,
    }));
    const result = await runCommand('   ', '/repo', undefined, spawn);
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain('empty command');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('passes a custom timeout through to spawn', async () => {
    const spawn: CommandSpawn = vi.fn(async () => ({
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 1,
    }));
    await runCommand('bun run build', '/repo', { timeoutMs: 5_000 }, spawn);
    const [, opts] = (spawn as unknown as { mock: { calls: [string, Parameters<CommandSpawn>[1]][] } }).mock.calls[0];
    expect(opts.timeoutMs).toBe(5_000);
  });
});
