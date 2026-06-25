/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/aionui-cmddoc' } }));

import { redactSecrets } from '@/process/terminal/commandDoc/commandRedact';
import { classifyCommand, replaceProgram } from '@/process/terminal/commandDoc/commandClassify';
import { bestGhost, matchScore, rankCommands } from '@/process/terminal/commandDoc/commandScore';
import { createCommandDocStore, type CommandDocFs } from '@/process/terminal/commandDoc/commandDocStore';
import { createCommandDocService } from '@/process/terminal/commandDoc/commandDocService';
import type { CommandRecord } from '@/process/terminal/commandDoc/commandTypes';

const NOW = Date.parse('2026-01-08T00:00:00.000Z');

const rec = (over: Partial<CommandRecord> = {}): CommandRecord => ({
  command: 'bun start',
  program: 'bun',
  count: 5,
  successCount: 5,
  firstUsedAt: NOW - 1000,
  lastUsedAt: NOW - 1000,
  lastExitCode: 0,
  ...over,
});

describe('commandRedact', () => {
  it('masks --token= / --password values', () => {
    expect(redactSecrets('deploy --token=abc123SECRET')).toBe('deploy --token=***');
    expect(redactSecrets('login --password mypw')).toBe('login --password ***');
  });
  it('masks credentials in a URL', () => {
    expect(redactSecrets('psql postgres://user:pa55word@host/db')).toContain('user:***@host');
  });
  it('masks long opaque mixed tokens but keeps plain words/paths', () => {
    expect(redactSecrets('run AbC123dEf456GhI789jKl012MnO345')).toBe('run ***');
    expect(redactSecrets('cd packages/desktop/src')).toBe('cd packages/desktop/src');
  });
});

describe('commandClassify', () => {
  it('splits program and args', () => {
    const c = classifyCommand('gemini chat --model x');
    expect(c.program).toBe('gemini');
    expect(c.args).toBe('chat --model x');
  });
  it('skips leading env assignments', () => {
    const c = classifyCommand('FOO=1 BAR=2 node app.js');
    expect(c.program).toBe('node');
    expect(c.env).toEqual(['FOO=1', 'BAR=2']);
  });
  it('uses the base name of a program path', () => {
    expect(classifyCommand('./bin/gemini run').program).toBe('gemini');
  });
  it('replaceProgram keeps env + args', () => {
    expect(replaceProgram('FOO=1 gemini chat --x', 'agi')).toBe('FOO=1 agi chat --x');
  });
});

describe('commandScore', () => {
  it('matchScore: exact prefix is 1 and flagged isPrefix', () => {
    expect(matchScore('bun', 'bun start')).toEqual({ score: 1, isPrefix: true });
  });
  it('matchScore: fuzzy subsequence is partial, not prefix', () => {
    const m = matchScore('bs', 'bun start');
    expect(m.isPrefix).toBe(false);
    expect(m.score).toBeGreaterThan(0);
  });
  it('ranks the frequent recent prefix match first', () => {
    const records = [
      rec({ command: 'bun start', count: 10, lastUsedAt: NOW - 1000 }),
      rec({ command: 'bun run build', program: 'bun', count: 1, lastUsedAt: NOW - 90 * 24 * 3600 * 1000 }),
    ];
    const ranked = rankCommands(records, { prefix: 'b', now: NOW }, 5);
    expect(ranked[0].command).toBe('bun start');
  });
  it('bestGhost returns a prefix continuation longer than the input', () => {
    const records = [rec({ command: 'bun start', count: 10 })];
    expect(bestGhost(records, { prefix: 'b', now: NOW })?.command).toBe('bun start');
    expect(bestGhost(records, { prefix: 'bun start', now: NOW })).toBeNull();
  });
  it('drops non-matching records when a prefix is given', () => {
    const records = [rec({ command: 'git push' }), rec({ command: 'bun start' })];
    const ranked = rankCommands(records, { prefix: 'bun', now: NOW }, 5);
    expect(ranked.map((r) => r.command)).toEqual(['bun start']);
  });
});

const memFs = (): CommandDocFs => {
  const files = new Map<string, string>();
  return {
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) {
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        return Promise.reject(e);
      }
      return Promise.resolve(v);
    },
    writeFile: (p, d) => {
      files.set(p, d);
      return Promise.resolve();
    },
    rename: (o, n) => {
      const v = files.get(o);
      if (v !== undefined) {
        files.set(n, v);
        files.delete(o);
      }
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(undefined),
  };
};

describe('commandDocStore', () => {
  it('round-trips records and starts empty', async () => {
    const store = createCommandDocStore({ rootDir: '/d', fs: memFs() });
    expect(await store.readAll()).toEqual([]);
    await store.writeAll([rec()]);
    expect((await store.readAll())[0].command).toBe('bun start');
  });
});

describe('commandDocService', () => {
  let store: ReturnType<typeof createCommandDocStore>;
  const flushes: Array<() => void> = [];
  const makeService = () =>
    createCommandDocService({
      store,
      now: () => NOW,
      schedule: (fn) => void flushes.push(fn),
    });

  beforeEach(() => {
    store = createCommandDocStore({ rootDir: '/d', fs: memFs() });
    flushes.length = 0;
  });

  it('captures a successful command and serves it as a suggestion', async () => {
    const svc = makeService();
    await svc.init();
    svc.capture({ command: 'bun start', exitCode: 0 });
    expect(svc.snapshot()).toHaveLength(1);
    expect(svc.suggest('b')[0].command).toBe('bun start');
  });

  it('increments count + successCount on repeat success', async () => {
    const svc = makeService();
    await svc.init();
    svc.capture({ command: 'bun start', exitCode: 0 });
    svc.capture({ command: 'bun start', exitCode: 0 });
    const r = svc.snapshot()[0];
    expect(r.count).toBe(2);
    expect(r.successCount).toBe(2);
  });

  it('records a failed command without crediting success', async () => {
    const svc = makeService();
    await svc.init();
    svc.capture({ command: 'gemini chat', exitCode: 1 });
    const r = svc.snapshot()[0];
    expect(r.count).toBe(1);
    expect(r.successCount).toBe(0);
    expect(r.lastExitCode).toBe(1);
  });

  it('redacts secrets before storing', async () => {
    const svc = makeService();
    await svc.init();
    svc.capture({ command: 'deploy --token=SUPERsecret123', exitCode: 0 });
    expect(svc.snapshot()[0].command).toBe('deploy --token=***');
  });

  it('skips trivial navigation commands', async () => {
    const svc = makeService();
    await svc.init();
    svc.capture({ command: 'cd', exitCode: 0 });
    svc.capture({ command: 'clear', exitCode: 0 });
    expect(svc.snapshot()).toHaveLength(0);
  });

  it('coalesces flushes and persists on flush', async () => {
    const svc = makeService();
    await svc.init();
    svc.capture({ command: 'bun start', exitCode: 0 });
    svc.capture({ command: 'bun test', exitCode: 0 });
    expect(flushes.length).toBe(1); // coalesced into one scheduled flush
    await svc.flush();
    expect((await store.readAll()).length).toBe(2);
  });
});
