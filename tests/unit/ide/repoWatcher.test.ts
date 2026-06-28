/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the realtime repo watcher. The `fs.watch` + existence check +
 * timers are all injected, so debouncing, filtering, and add/remove
 * classification are exercised deterministically with no real disk.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createRepoWatcher,
  isIgnoredPath,
  isWatchedFile,
  type RawWatchEventType,
  type RepoWatcherDeps,
} from '@/process/ide/repoWatcher';
import type { RepoChangeEvent } from '@/process/ide/understandTypes';

describe('isIgnoredPath / isWatchedFile', () => {
  it('ignores vendor/build dirs', () => {
    expect(isIgnoredPath('node_modules/react/index.js')).toBe(true);
    expect(isIgnoredPath('.git/HEAD')).toBe(true);
    expect(isIgnoredPath('\x2eomni/wiki/wiki.json')).toBe(true);
    expect(isIgnoredPath('.aionui/understand/stale.json')).toBe(true);
    expect(isIgnoredPath('.mtui/history.sqlite')).toBe(true);
    expect(isIgnoredPath('src/app.ts')).toBe(false);
  });

  it('watches code/doc files only', () => {
    expect(isWatchedFile('src/app.ts')).toBe(true);
    expect(isWatchedFile('main.rs')).toBe(true);
    expect(isWatchedFile('README.md')).toBe(true);
    expect(isWatchedFile('image.png')).toBe(false);
  });
});

/** A controllable fake `fs.watch` + manual timer pump. */
const makeHarness = (existing: Set<string>) => {
  let emit: ((type: RawWatchEventType, rel: string) => void) | null = null;
  let pendingFlush: (() => void) | null = null;
  const deps: RepoWatcherDeps = {
    watch: (_root, onEvent) => {
      emit = onEvent;
      return { close: vi.fn() };
    },
    exists: (_root, rel) => existing.has(rel),
    setTimer: (fn) => {
      pendingFlush = fn;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {
      pendingFlush = null;
    },
  };
  return {
    deps,
    fire: (type: RawWatchEventType, rel: string): void => emit?.(type, rel),
    flush: (): void => pendingFlush?.(),
  };
};

describe('createRepoWatcher', () => {
  it('debounces a burst into a single change event (added/changed)', () => {
    const harness = makeHarness(new Set(['src/a.ts', 'src/b.ts']));
    const watcher = createRepoWatcher(harness.deps);
    const events: RepoChangeEvent[] = [];
    watcher.start('/repo', (e) => events.push(e));

    harness.fire('change', 'src/a.ts');
    harness.fire('change', 'src/b.ts');
    harness.fire('change', 'src/a.ts'); // duplicate within the burst
    expect(events).toHaveLength(0); // nothing until the debounce flush
    harness.flush();

    expect(events).toHaveLength(1);
    expect(events[0].changed).toEqual(['src/a.ts', 'src/b.ts']);
    expect(events[0].removed).toEqual([]);
  });

  it('classifies a missing file as removed', () => {
    const harness = makeHarness(new Set()); // nothing exists → removed
    const watcher = createRepoWatcher(harness.deps);
    const events: RepoChangeEvent[] = [];
    watcher.start('/repo', (e) => events.push(e));

    harness.fire('rename', 'src/gone.ts');
    harness.flush();

    expect(events[0].removed).toEqual(['src/gone.ts']);
    expect(events[0].changed).toEqual([]);
  });

  it('filters out ignored dirs and non-code files', () => {
    const harness = makeHarness(
      new Set([
        'node_modules/x/index.js',
        '.aionui/understand/stale.json',
        '.mtui/history.sqlite',
        'img.png',
        'src/ok.ts',
      ])
    );
    const watcher = createRepoWatcher(harness.deps);
    const events: RepoChangeEvent[] = [];
    watcher.start('/repo', (e) => events.push(e));

    harness.fire('change', 'node_modules/x/index.js');
    harness.fire('change', '.aionui/understand/stale.json');
    harness.fire('change', '.mtui/history.sqlite');
    harness.fire('change', 'img.png');
    harness.fire('change', 'src/ok.ts');
    harness.flush();

    expect(events[0].changed).toEqual(['src/ok.ts']);
  });

  it('stop() is idempotent and closes the handle', () => {
    const close = vi.fn();
    const deps: RepoWatcherDeps = { watch: () => ({ close }), exists: () => true };
    const watcher = createRepoWatcher(deps);
    watcher.start('/repo', () => undefined);
    expect(watcher.isActive()).toBe(true);
    watcher.stop();
    watcher.stop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(watcher.isActive()).toBe(false);
  });
});
