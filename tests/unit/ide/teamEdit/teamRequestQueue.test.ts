/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createTeamRequestQueue } from '@/process/ide/teamEdit/teamRequestQueue';

const wait = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('teamRequestQueue ? remote host back-pressure', () => {
  it('runs tasks FIFO with the configured per-workspace concurrency', async () => {
    const queue = createTeamRequestQueue({ maxConcurrent: 1 });
    const events: string[] = [];

    const first = queue.enqueue('/repo', 'first', async () => {
      events.push('first:start');
      await wait(10);
      events.push('first:end');
      return 'a';
    });
    const second = queue.enqueue('/repo', 'second', async () => {
      events.push('second:start');
      events.push('second:end');
      return 'b';
    });

    await expect(Promise.all([first, second])).resolves.toEqual(['a', 'b']);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('keeps independent workspaces from blocking each other', async () => {
    const queue = createTeamRequestQueue({ maxConcurrent: 1 });
    const events: string[] = [];

    const a = queue.enqueue('/repo-a', 'a', async () => {
      events.push('a:start');
      await wait(15);
      events.push('a:end');
      return 'a';
    });
    const b = queue.enqueue('/repo-b', 'b', async () => {
      events.push('b:start');
      events.push('b:end');
      return 'b';
    });

    await expect(Promise.all([a, b])).resolves.toEqual(['a', 'b']);
    expect(events.slice(0, 2).toSorted()).toEqual(['a:start', 'b:start']);
  });

  it('continues draining after a task fails', async () => {
    const queue = createTeamRequestQueue({ maxConcurrent: 1 });
    const events: string[] = [];

    const first = queue.enqueue('/repo', 'first', async () => {
      events.push('first');
      throw new Error('boom');
    });
    const second = queue.enqueue('/repo', 'second', async () => {
      events.push('second');
      return 'ok';
    });

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('ok');
    expect(events).toEqual(['first', 'second']);
  });

  it('rejects new work when the pending queue is full', async () => {
    const queue = createTeamRequestQueue({ maxConcurrent: 1, maxPending: 1 });
    const blocker = queue.enqueue('/repo', 'blocker', () => new Promise<string>(() => undefined));
    void blocker.catch(() => undefined);
    void queue.enqueue('/repo', 'waiting', async () => 'waiting');
    await expect(queue.enqueue('/repo', 'overflow', async () => 'overflow')).rejects.toThrow(
      'Remote IDE queue is full'
    );
  });
});
