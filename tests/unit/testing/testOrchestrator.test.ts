/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Property 2 & 3 for the testing layer (Yêu cầu 2b, criteria 2.7 / 2.10): every
 * test session goes through the ResourceCoordinator (each acquires a lease keyed
 * by platform, released exactly once), and over-budget sessions queue rather than
 * overload. Also covers the orchestrator's session lifecycle + report wiring.
 *
 * fast-check is not a dependency; a deterministic seeded PRNG drives randomized
 * session sequences with failure injection. No real display/emulator is used.
 *
 * Validates: Requirements 2.7, 2.10
 */

import { describe, expect, it, vi } from 'vitest';
import { createTestOrchestrator } from '@/process/testing/testOrchestrator';
import type { ITestDriver } from '@/process/testing/scriptDriver';
import type { IRecorder } from '@/process/testing/recorder';
import type { IVirtualDisplayManager, VirtualDisplay } from '@/process/testing/virtualDisplayManager';
import type { IPlatformTarget } from '@/process/testing/platforms/platformTarget';
import type { TestPlatform, TestScenario } from '@/process/testing/testingTypes';
import type { Lease, LeaseRequest, TaskKind } from '@/process/resource/leaseTypes';

const PROPERTY_RUNS = 150;

const makeRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const forAllSeeds = async (runs: number, check: (rng: () => number, run: number) => Promise<void>): Promise<void> => {
  for (let run = 0; run < runs; run++) {
    const seed = ((run + 1) * 0x9e3779b1) >>> 0;
    try {
      await check(makeRng(seed), run);
    } catch (error) {
      throw new Error(`Property failed on run ${run} (seed ${seed}): ${(error as Error).message}`, { cause: error });
    }
  }
};

const randInt = (rng: () => number, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));

/** Lease accounting coordinator: records grants/releases, tracks held + queue depth. */
const createAccountingCoordinator = (maxConcurrent = 1) => {
  const held = new Set<string>();
  const grants: LeaseRequest[] = [];
  const releases: string[] = [];
  let n = 0;
  let live = 0;
  let maxObservedLive = 0;
  const waiters: Array<() => void> = [];

  const requestLease = async (req: LeaseRequest): Promise<Lease> => {
    grants.push(req);
    // Emulate a budget: only `maxConcurrent` leases live at once; others queue.
    if (live >= maxConcurrent) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    live += 1;
    maxObservedLive = Math.max(maxObservedLive, live);
    const id = `lease-${++n}`;
    held.add(id);
    return { id, kind: req.kind, grantedAt: n, estCostMB: req.estCostMB };
  };

  const releaseLease = (id: string): void => {
    releases.push(id);
    if (held.delete(id)) {
      live -= 1;
      const next = waiters.shift();
      if (next) next();
    }
  };

  return {
    coordinator: { requestLease, releaseLease },
    held,
    grants,
    releases,
    get maxObservedLive() {
      return maxObservedLive;
    },
  };
};

const okDriver: ITestDriver = { kind: 'script', runStep: async () => ({ passed: true }) };

const fakeRecorder = (): IRecorder => ({
  start: async (sessionId, target) => ({ sessionId, target, videoPath: `/rec/${sessionId}.webm`, screenshots: [] }),
  snapshot: async (_handle, label) => `/shot/${label}.png`,
  stop: async (handle) => ({ videoPath: handle.videoPath, screenshots: handle.screenshots }),
});

const fakeDisplayManager = (): IVirtualDisplayManager => {
  let n = 0;
  const held: VirtualDisplay[] = [];
  return {
    acquire: async () => {
      const d: VirtualDisplay = { id: `disp-${++n}`, backend: 'fake', isolated: true, target: { display: `d${n}` } };
      held.push(d);
      return d;
    },
    release: async (id) => {
      const i = held.findIndex((d) => d.id === id);
      if (i >= 0) held.splice(i, 1);
    },
    list: () => [...held],
  };
};

const fakeTarget = (platform: TestPlatform): IPlatformTarget => ({
  platform,
  availableViewports: () => [{ width: 100, height: 100 }],
  prepare: async (displayTarget) => ({ platform, target: { ...displayTarget, prepared: 'yes' } }),
  teardown: async () => undefined,
});

const scenario = (platform: TestPlatform): TestScenario => ({
  id: `scn-${platform}`,
  name: `${platform} test`,
  platform,
  steps: [
    { id: 's1', description: 'step one' },
    { id: 's2', description: 'step two' },
  ],
});

const buildOrchestrator = (coordinator: {
  requestLease: (r: LeaseRequest) => Promise<Lease>;
  releaseLease: (id: string) => void;
}) =>
  createTestOrchestrator({
    displayManager: fakeDisplayManager(),
    targets: [fakeTarget('web'), fakeTarget('android'), fakeTarget('windows')],
    scriptDriver: okDriver,
    computerUseDriver: okDriver,
    recorder: fakeRecorder(),
    coordinator,
    writeReport: async (sessionId) => `/reports/${sessionId}.md`,
  });

const EXPECTED_KIND: Record<TestPlatform, TaskKind> = { web: 'browser', android: 'emulator', windows: 'windowsTest' };

describe('testOrchestrator — Property 2 & 3: every session leases; balanced; queues over budget', () => {
  it('runs a session to passed, leasing the platform-specific kind and releasing it', async () => {
    const acct = createAccountingCoordinator(4);
    const orchestrator = buildOrchestrator(acct.coordinator);

    const session = await orchestrator.run(scenario('windows'), { visibility: 'hidden' });

    expect(session.status).toBe('passed');
    expect(session.reportPath).toBe(`/reports/${session.id}.md`);
    expect(session.videoPath).toBe(`/rec/${session.id}.webm`);
    expect(acct.grants.map((g) => g.kind)).toEqual(['windowsTest']);
    expect(acct.held.size).toBe(0); // released
  });

  it('maps each platform to its heavy-task lease kind', async () => {
    for (const platform of ['web', 'android', 'windows'] as TestPlatform[]) {
      const acct = createAccountingCoordinator(4);
      const orchestrator = buildOrchestrator(acct.coordinator);
      await orchestrator.run(scenario(platform));
      expect(acct.grants.map((g) => g.kind)).toEqual([EXPECTED_KIND[platform]]);
      expect(acct.held.size).toBe(0);
    }
  });

  it('never exceeds the budget: concurrent sessions queue (max live == budget)', async () => {
    const budget = 2;
    const acct = createAccountingCoordinator(budget);
    const orchestrator = buildOrchestrator(acct.coordinator);

    // Fire 6 sessions at once; the coordinator only lets `budget` run concurrently.
    await Promise.all(Array.from({ length: 6 }, () => orchestrator.run(scenario('web'))));

    expect(acct.maxObservedLive).toBeLessThanOrEqual(budget);
    expect(acct.held.size).toBe(0);
    expect(acct.releases.length).toBe(acct.grants.length);
  });

  it('keeps leases balanced across randomized session sequences with display failures', async () => {
    await forAllSeeds(PROPERTY_RUNS, async (rng) => {
      const acct = createAccountingCoordinator(randInt(rng, 1, 3));
      // Randomly make display acquisition fail to exercise the error path's release.
      const failingDisplay = rng() < 0.3;
      const displayManager: IVirtualDisplayManager = failingDisplay
        ? {
            acquire: async () => {
              throw new Error('no display');
            },
            release: async () => undefined,
            list: () => [],
          }
        : fakeDisplayManager();

      const orchestrator = createTestOrchestrator({
        displayManager,
        targets: [fakeTarget('web'), fakeTarget('android'), fakeTarget('windows')],
        scriptDriver: okDriver,
        computerUseDriver: okDriver,
        recorder: fakeRecorder(),
        coordinator: acct.coordinator,
        writeReport: async (id) => `/r/${id}.md`,
      });

      const platforms: TestPlatform[] = ['web', 'android', 'windows'];
      const count = randInt(rng, 1, 5);
      await Promise.all(Array.from({ length: count }, () => orchestrator.run(scenario(platforms[randInt(rng, 0, 2)]))));

      // Whatever happened (success or display error), every lease was released.
      expect(acct.held.size).toBe(0);
      expect(acct.releases.length).toBe(acct.grants.length);
    });
  });
});

describe('testOrchestrator — session lifecycle', () => {
  it('errors gracefully (and releases the lease) when no platform target exists', async () => {
    const acct = createAccountingCoordinator(2);
    const orchestrator = createTestOrchestrator({
      displayManager: fakeDisplayManager(),
      targets: [fakeTarget('web')], // no windows target
      scriptDriver: okDriver,
      computerUseDriver: okDriver,
      recorder: fakeRecorder(),
      coordinator: acct.coordinator,
      writeReport: async (id) => `/r/${id}.md`,
    });

    const session = await orchestrator.run(scenario('windows'));
    expect(session.status).toBe('error');
    // No lease was requested because the target check fails first; nothing held.
    expect(acct.held.size).toBe(0);
  });

  it('marks failed when a step fails and still writes a report', async () => {
    const acct = createAccountingCoordinator(2);
    const failingDriver: ITestDriver = {
      kind: 'script',
      runStep: vi.fn(async (step) => ({ passed: step.id !== 's2', detail: step.id === 's2' ? 'boom' : undefined })),
    };
    const orchestrator = createTestOrchestrator({
      displayManager: fakeDisplayManager(),
      targets: [fakeTarget('web')],
      scriptDriver: failingDriver,
      computerUseDriver: okDriver,
      recorder: fakeRecorder(),
      coordinator: acct.coordinator,
      writeReport: async (id) => `/r/${id}.md`,
    });

    const session = await orchestrator.run(scenario('web'));
    expect(session.status).toBe('failed');
    expect(session.reportPath).toBe(`/r/${session.id}.md`);
    expect(acct.held.size).toBe(0);
  });
});
