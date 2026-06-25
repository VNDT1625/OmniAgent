/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createRtkScheduler, type ArmCronFn } from '@/process/knowledge/realtime/rtkScheduler';

/** A fake arm that captures the tick callback so tests can fire it manually. */
const fakeArm = (): { arm: ArmCronFn; tick: () => void; stopped: () => number } => {
  let onTick = (): void => {};
  let stops = 0;
  return {
    arm: (_expr, cb) => {
      onTick = cb;
      return { stop: () => void (stops += 1) };
    },
    tick: () => onTick(),
    stopped: () => stops,
  };
};

const silent = { warn: vi.fn(), error: vi.fn() };

describe('rtkScheduler', () => {
  it('runs the sweep on each tick', async () => {
    const runSweep = vi.fn().mockResolvedValue(undefined);
    const f = fakeArm();
    const scheduler = createRtkScheduler({ runSweep, arm: f.arm, log: silent });
    scheduler.start();
    f.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(runSweep).toHaveBeenCalledTimes(1);
  });

  it('does not overlap sweeps (re-entrancy guard)', async () => {
    let resolveSweep = (): void => {};
    const runSweep = vi.fn().mockImplementation(() => new Promise<void>((r) => (resolveSweep = r)));
    const scheduler = createRtkScheduler({ runSweep, log: silent });
    const first = scheduler.runNow();
    const second = scheduler.runNow(); // should be ignored while first runs
    expect(scheduler.isRunning()).toBe(true);
    resolveSweep();
    await Promise.all([first, second]);
    expect(runSweep).toHaveBeenCalledTimes(1);
  });

  it('pauses after too many consecutive failures', async () => {
    const runSweep = vi.fn().mockRejectedValue(new Error('offline'));
    const scheduler = createRtkScheduler({ runSweep, maxConsecutiveFailures: 2, log: silent });
    await scheduler.runNow();
    await scheduler.runNow();
    await scheduler.runNow(); // skipped — limit reached
    expect(runSweep).toHaveBeenCalledTimes(2);
  });

  it('resets the failure counter after a success', async () => {
    const runSweep = vi
      .fn()
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('y'));
    const scheduler = createRtkScheduler({ runSweep, maxConsecutiveFailures: 2, log: silent });
    await scheduler.runNow(); // fail (1)
    await scheduler.runNow(); // success → reset
    await scheduler.runNow(); // fail (1 again, not paused)
    expect(runSweep).toHaveBeenCalledTimes(3);
  });

  it('stop() halts the armed job', () => {
    const f = fakeArm();
    const scheduler = createRtkScheduler({ runSweep: vi.fn(), arm: f.arm, log: silent });
    scheduler.start();
    scheduler.stop();
    expect(f.stopped()).toBe(1);
  });
});
