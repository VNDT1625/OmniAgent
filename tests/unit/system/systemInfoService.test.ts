/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { LiveSystemMetrics, StaticSystemInfo } from '@process/system/systemInfoTypes';
import {
  createSystemInfoService,
  SNAPSHOT_INTERVAL_MS,
  type SystemInfoServiceDeps,
} from '@process/system/systemInfoService';

const staticInfo = (): StaticSystemInfo => ({
  probedAt: 1,
  os: { platform: 'linux', type: 'Linux', release: '6', version: '', arch: 'x64', hostname: 'h', username: 'u' },
  cpu: { model: 'CPU', logicalCores: 4, speedMHz: 3000 },
  totalMemoryMB: 16384,
  gpus: [],
  disks: [],
  network: [],
  versions: { app: '1', electron: '1', chrome: '1', node: '1', v8: '1' },
});

const live = (sampledAt: number, pid = 1): LiveSystemMetrics => ({
  sampledAt,
  cpu: { overallPercent: 10, perCorePercent: [10] },
  memory: { totalMB: 16384, usedMB: 8192, freeMB: 8192, usedPercent: 50 },
  loadAvg: [0, 0, 0],
  uptimeSec: 1,
  processes: [{ pid, type: 'Tab', name: 'X', cpuPercent: 1, memoryMB: 1, priority: 0 }],
  power: { onBattery: false },
});

/** Build a service with controllable timer + sampler. */
const harness = () => {
  let timerHandler: (() => void) | null = null;
  let intervalMs = 0;
  let clearCount = 0;
  let sampledAt = 1000;
  const writes: number[] = [];
  const reapplyCalls: number[] = [];
  const setPriorityCalls: Array<[number, string]> = [];

  const deps: SystemInfoServiceDeps = {
    dataDir: '/data',
    probeStatic: vi.fn(async () => staticInfo()),
    sampler: {
      sample: () => {
        sampledAt += 1000;
        return live(sampledAt);
      },
    },
    snapshotStore: { write: (s) => writes.push(s.live.sampledAt) },
    priorityManager: {
      setPriority: (pid, level) => {
        setPriorityCalls.push([pid, level]);
        return { ok: true, pid, level };
      },
      getChoice: () => undefined,
      reapply: (procs) => reapplyCalls.push(procs.length),
    },
    setInterval: ((handler: () => void, ms: number) => {
      timerHandler = handler;
      intervalMs = ms;
      return 1 as unknown as NodeJS.Timeout;
    }) as SystemInfoServiceDeps['setInterval'],
    clearInterval: (() => {
      clearCount += 1;
    }) as SystemInfoServiceDeps['clearInterval'],
  };

  const service = createSystemInfoService(deps);
  return {
    service,
    tick: () => timerHandler?.(),
    getInterval: () => intervalMs,
    getClearCount: () => clearCount,
    writes,
    reapplyCalls,
    setPriorityCalls,
    setSampledAt: (v: number) => (sampledAt = v),
  };
};

describe('createSystemInfoService', () => {
  it('probes static info and primes a first sample on start', async () => {
    const h = harness();
    await h.service.start();
    expect(h.service.getStaticInfo()).not.toBeNull();
    const snapshot = h.service.getSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.history.length).toBe(1);
    expect(h.writes.length).toBe(0); // first tick is throttled until the snapshot cadence elapses
    expect(h.reapplyCalls).toEqual([1]);
  });

  it('starts at the slow cadence and switches to fast while streaming', async () => {
    const h = harness();
    await h.service.start();
    expect(h.getInterval()).toBe(SNAPSHOT_INTERVAL_MS);
    h.service.startStream();
    expect(h.getInterval()).toBe(2000);
    h.service.stopStream();
    expect(h.getInterval()).toBe(SNAPSHOT_INTERVAL_MS);
  });

  it('emits to subscribers only while streaming', async () => {
    const h = harness();
    await h.service.start();
    const received: number[] = [];
    h.service.onMetrics((m) => received.push(m.sampledAt));

    h.tick(); // not streaming → no emit
    expect(received.length).toBe(0);

    h.service.startStream();
    h.tick();
    expect(received.length).toBe(1);
  });

  it('throttles snapshot writes to the slow interval', async () => {
    const h = harness();
    await h.service.start(); // write #1 at sampledAt=2000
    const afterStart = h.writes.length;
    h.tick(); // sampledAt=3000, only +1000 < interval → no write
    expect(h.writes.length).toBe(afterStart);
  });

  it('refreshStatic re-probes and writes a fresh snapshot', async () => {
    const h = harness();
    await h.service.start();
    const before = h.writes.length;
    const fresh = await h.service.refreshStatic();
    expect(fresh.cpu.logicalCores).toBe(4);
    expect(h.writes.length).toBe(before + 1);
  });

  it('routes a priority change through the manager with the live identity', async () => {
    const h = harness();
    await h.service.start();
    const result = h.service.setProcessPriority(1, 'low');
    expect(result.ok).toBe(true);
    expect(h.setPriorityCalls).toEqual([[1, 'low']]);
  });

  it('stops the timer and clears subscribers on stop', async () => {
    const h = harness();
    await h.service.start();
    const before = h.getClearCount();
    h.service.stop();
    expect(h.getClearCount()).toBe(before + 1);
  });
});
