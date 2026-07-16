/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { CpuInfo } from 'node:os';
import { createLiveSampler, type LiveSamplerDeps } from '@process/system/liveMetricsSampler';

/** Build a fake `os.cpus()` core entry from busy/idle tick counts. */
const core = (busy: number, idle: number): CpuInfo => ({
  model: 'Test CPU',
  speed: 3000,
  times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
});

const baseDeps = (overrides: Partial<LiveSamplerDeps> = {}): Partial<LiveSamplerDeps> => ({
  getTotalMemBytes: () => 16 * 1024 * 1024 * 1024,
  getFreeMemBytes: () => 4 * 1024 * 1024 * 1024,
  getLoadAvg: () => [1.5, 1.0, 0.5],
  getUptimeSec: () => 3600,
  getAppMetrics: () => [],
  getPriority: () => 0,
  isOnBattery: () => false,
  ...overrides,
});

describe('createLiveSampler', () => {
  it('reports ~0% CPU on the first sample (no prior delta)', () => {
    const sampler = createLiveSampler(baseDeps({ getCpus: () => [core(100, 900)] }));
    const first = sampler.sample();
    expect(first.cpu.overallPercent).toBe(0);
    expect(first.cpu.perCorePercent).toEqual([0]);
  });

  it('computes per-core utilisation from the delta between samples', () => {
    let cpus = [core(100, 900), core(100, 900)];
    const sampler = createLiveSampler(baseDeps({ getCpus: () => cpus }));
    sampler.sample(); // seed
    // Advance: core 0 fully busy (+100 busy), core 1 idle (+100 idle).
    cpus = [core(200, 900), core(100, 1000)];
    const next = sampler.sample();
    expect(next.cpu.perCorePercent[0]).toBe(100);
    expect(next.cpu.perCorePercent[1]).toBe(0);
    expect(next.cpu.overallPercent).toBe(50);
  });

  it('computes memory usage in MB and percent', () => {
    const sampler = createLiveSampler(baseDeps({ getCpus: () => [core(1, 1)] }));
    const sample = sampler.sample();
    expect(sample.memory.totalMB).toBe(16384);
    expect(sample.memory.freeMB).toBe(4096);
    expect(sample.memory.usedMB).toBe(12288);
    expect(sample.memory.usedPercent).toBe(75);
  });

  it('maps and sorts processes by CPU descending', () => {
    const sampler = createLiveSampler(
      baseDeps({
        getCpus: () => [core(1, 1)],
        getAppMetrics: () => [
          { pid: 1, type: 'Browser', cpu: { percentCPUUsage: 3.2 }, memory: { workingSetSize: 200 * 1024 } },
          {
            pid: 2,
            type: 'Tab',
            name: 'Renderer',
            cpu: { percentCPUUsage: 42.7 },
            memory: { workingSetSize: 512 * 1024 },
          },
        ],
        getPriority: (pid) => (pid === 2 ? 10 : 0),
      })
    );
    const sample = sampler.sample();
    expect(sample.processes.map((p) => p.pid)).toEqual([2, 1]);
    expect(sample.processes[0]).toMatchObject({ name: 'Renderer', cpuPercent: 42.7, memoryMB: 512, priority: 10 });
    expect(sample.processes[1]).toMatchObject({ type: 'Browser', memoryMB: 200 });
  });

  it('passes through load average, uptime and battery state', () => {
    const sampler = createLiveSampler(baseDeps({ getCpus: () => [core(1, 1)], isOnBattery: () => true }));
    const sample = sampler.sample();
    expect(sample.loadAvg).toEqual([1.5, 1.0, 0.5]);
    expect(sample.uptimeSec).toBe(3600);
    expect(sample.power.onBattery).toBe(true);
  });
});
