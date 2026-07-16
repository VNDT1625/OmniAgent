/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ProcessMetric } from '@process/system/systemInfoTypes';
import {
  createPriorityManager,
  levelFromNice,
  PRIORITY_NICE,
  processIdentity,
  type PriorityManagerDeps,
} from '@process/system/processPriorityManager';

/** In-memory fs-backed deps for the priority store. */
const memoryDeps = (
  initial?: string
): { deps: PriorityManagerDeps; getWritten: () => string | null; setCalls: Array<[number, number]> } => {
  let file: string | null = initial ?? null;
  const setCalls: Array<[number, number]> = [];
  const deps: PriorityManagerDeps = {
    setPriority: (pid, nice) => {
      setCalls.push([pid, nice]);
    },
    storeDir: '/data',
    readFile: () => {
      if (file === null) throw new Error('ENOENT');
      return file;
    },
    writeFile: (_path, data) => {
      file = data;
    },
  };
  return { deps, getWritten: () => file, setCalls };
};

const proc = (pid: number, type: string, name: string, priority: number | null): ProcessMetric => ({
  pid,
  type,
  name,
  cpuPercent: 0,
  memoryMB: 0,
  priority,
});

describe('levelFromNice', () => {
  it('maps nice values to the nearest level', () => {
    expect(levelFromNice(PRIORITY_NICE.high)).toBe('high');
    expect(levelFromNice(PRIORITY_NICE.normal)).toBe('normal');
    expect(levelFromNice(PRIORITY_NICE.low)).toBe('low');
    expect(levelFromNice(-6)).toBe('aboveNormal');
  });
});

describe('processIdentity', () => {
  it('combines type and name', () => {
    expect(processIdentity({ type: 'Tab', name: 'Editor' })).toBe('Tab:Editor');
  });
});

describe('createPriorityManager', () => {
  it('applies a nice value and persists the choice by identity', () => {
    const { deps, getWritten, setCalls } = memoryDeps();
    const manager = createPriorityManager(deps);
    const result = manager.setPriority(1234, 'low', 'Tab:Heavy');
    expect(result).toMatchObject({ ok: true, pid: 1234, level: 'low' });
    expect(setCalls).toEqual([[1234, PRIORITY_NICE.low]]);
    expect(manager.getChoice('Tab:Heavy')).toBe('low');
    expect(getWritten()).toContain('"Tab:Heavy"');
  });

  it('returns a soft error when setPriority throws (e.g. EPERM)', () => {
    const { deps } = memoryDeps();
    deps.setPriority = () => {
      throw new Error('EPERM');
    };
    const manager = createPriorityManager(deps);
    const result = manager.setPriority(1, 'high', 'a:b');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('EPERM');
  });

  it('loads persisted choices on construction', () => {
    const { deps } = memoryDeps(JSON.stringify({ 'GPU:gpu': 'belowNormal' }));
    const manager = createPriorityManager(deps);
    expect(manager.getChoice('GPU:gpu')).toBe('belowNormal');
  });

  it('reapplies remembered choices only to mismatched live processes', () => {
    const { deps, setCalls } = memoryDeps(JSON.stringify({ 'Tab:Heavy': 'low', 'GPU:gpu': 'belowNormal' }));
    const manager = createPriorityManager(deps);
    setCalls.length = 0; // ignore construction
    manager.reapply([
      proc(10, 'Tab', 'Heavy', 0), // mismatch (currently normal) → reapply
      proc(20, 'GPU', 'gpu', PRIORITY_NICE.belowNormal), // already correct → skip
      proc(30, 'Tab', 'Other', 0), // no remembered choice → skip
    ]);
    expect(setCalls).toEqual([[10, PRIORITY_NICE.low]]);
  });

  it('tolerates a corrupt store file', () => {
    const { deps } = memoryDeps('not json {{{');
    const manager = createPriorityManager(deps);
    expect(manager.getChoice('anything')).toBeUndefined();
  });
});
