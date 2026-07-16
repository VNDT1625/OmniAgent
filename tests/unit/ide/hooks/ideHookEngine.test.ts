/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { computeHookFirings, isHookRunnable, manualFiring } from '@/process/ide/hooks/ideHookEngine';
import type { IdeHook } from '@/process/ide/hooks/ideHookTypes';
import type { RepoChangeEvent } from '@/process/ide/understandTypes';

const hook = (over: Partial<IdeHook>): IdeHook => ({
  id: over.id ?? 'h1',
  name: over.name ?? 'Hook',
  enabled: over.enabled ?? true,
  event: over.event ?? 'fileSaved',
  filePatterns: over.filePatterns ?? [],
  action: over.action ?? 'askAgent',
  prompt: over.prompt ?? 'do something',
  command: over.command,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const event = (over: Partial<RepoChangeEvent>): RepoChangeEvent => ({
  rootPath: over.rootPath ?? '/repo',
  changed: over.changed ?? [],
  removed: over.removed ?? [],
});

describe('isHookRunnable', () => {
  it('false when disabled', () => {
    expect(isHookRunnable(hook({ enabled: false }))).toBe(false);
  });
  it('askAgent needs a non-empty prompt', () => {
    expect(isHookRunnable(hook({ action: 'askAgent', prompt: '   ' }))).toBe(false);
    expect(isHookRunnable(hook({ action: 'askAgent', prompt: 'ok' }))).toBe(true);
  });
  it('runCommand needs a non-empty command', () => {
    expect(isHookRunnable(hook({ action: 'runCommand', command: '', prompt: undefined }))).toBe(false);
    expect(isHookRunnable(hook({ action: 'runCommand', command: 'npm run lint', prompt: undefined }))).toBe(true);
  });
});

describe('computeHookFirings', () => {
  it('fires a fileSaved hook for a changed path matching its pattern', () => {
    const hooks = [hook({ id: 'a', event: 'fileSaved', filePatterns: ['*.ts'] })];
    const firings = computeHookFirings(hooks, event({ changed: ['src/x.ts'] }));
    expect(firings).toHaveLength(1);
    expect(firings[0].hook.id).toBe('a');
    expect(firings[0].relPath).toBe('src/x.ts');
    expect(firings[0].rootPath).toBe('/repo');
  });

  it('fileCreated hooks also fire on changed paths (watcher cannot distinguish)', () => {
    const hooks = [hook({ id: 'c', event: 'fileCreated', filePatterns: [] })];
    expect(computeHookFirings(hooks, event({ changed: ['new.ts'] }))).toHaveLength(1);
  });

  it('fileDeleted hooks fire only on removed paths', () => {
    const hooks = [hook({ id: 'd', event: 'fileDeleted', filePatterns: [] })];
    expect(computeHookFirings(hooks, event({ changed: ['a.ts'] }))).toHaveLength(0);
    expect(computeHookFirings(hooks, event({ removed: ['a.ts'] }))).toHaveLength(1);
  });

  it('fires each hook at most once per burst even with several matching files', () => {
    const hooks = [hook({ id: 'a', filePatterns: ['*.ts'] })];
    const firings = computeHookFirings(hooks, event({ changed: ['a.ts', 'b.ts', 'c.ts'] }));
    expect(firings).toHaveLength(1);
    expect(firings[0].relPath).toBe('a.ts');
  });

  it('skips disabled and non-runnable hooks, and pattern mismatches', () => {
    const hooks = [
      hook({ id: 'off', enabled: false }),
      hook({ id: 'noprompt', action: 'askAgent', prompt: '' }),
      hook({ id: 'nomatch', filePatterns: ['*.md'] }),
    ];
    expect(computeHookFirings(hooks, event({ changed: ['x.ts'] }))).toHaveLength(0);
  });
});

describe('manualFiring', () => {
  it('returns a firing for a runnable hook (no path)', () => {
    const f = manualFiring(hook({ id: 'm' }), '/repo');
    expect(f?.hook.id).toBe('m');
    expect(f?.relPath).toBeUndefined();
  });
  it('returns null for a non-runnable hook', () => {
    expect(manualFiring(hook({ enabled: false }), '/repo')).toBeNull();
  });
});
