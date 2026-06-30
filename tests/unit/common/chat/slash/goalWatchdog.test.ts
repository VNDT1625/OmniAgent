/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  armWatchdog,
  createInitialWatchdogState,
  disarmWatchdog,
  enterCooldown,
  evaluateWatchdog,
  markResumed,
  recordActivity,
  type GoalWatchdogConfig,
} from '@/common/chat/slash/goalWatchdog';

const CONFIG: GoalWatchdogConfig = {
  stallTimeoutMs: 1000,
  resumeDelayMs: 500,
  maxResumes: 2,
};

describe('evaluateWatchdog', () => {
  it('does nothing when idle', () => {
    const state = createInitialWatchdogState();
    expect(evaluateWatchdog(state, 10_000, CONFIG)).toEqual({ type: 'none' });
  });

  it('does nothing while running with recent activity', () => {
    const state = armWatchdog(0);
    expect(evaluateWatchdog(state, 999, CONFIG)).toEqual({ type: 'none' });
  });

  it('signals stop when running stalls past the timeout', () => {
    const state = armWatchdog(0);
    expect(evaluateWatchdog(state, 1000, CONFIG)).toEqual({ type: 'stop' });
  });

  it('signals giveup instead of stop once maxResumes reached', () => {
    let state = armWatchdog(0);
    state = markResumed(state, 0); // 1
    state = markResumed(state, 0); // 2 === maxResumes
    expect(evaluateWatchdog(state, 5000, CONFIG)).toEqual({ type: 'giveup' });
  });

  it('signals resume after the cooldown elapses', () => {
    const running = armWatchdog(0);
    const cooling = enterCooldown(running, 2000);
    expect(evaluateWatchdog(cooling, 2499, CONFIG)).toEqual({ type: 'none' });
    expect(evaluateWatchdog(cooling, 2500, CONFIG)).toEqual({ type: 'resume' });
  });

  it('signals giveup after cooldown when resumes are exhausted', () => {
    let state = armWatchdog(0);
    state = markResumed(state, 0);
    state = markResumed(state, 0); // at cap
    const cooling = enterCooldown(state, 1000);
    expect(evaluateWatchdog(cooling, 2000, CONFIG)).toEqual({ type: 'giveup' });
  });
});

describe('watchdog transitions', () => {
  it('recordActivity refreshes lastActivityAt only while running', () => {
    const running = armWatchdog(0);
    expect(recordActivity(running, 500).lastActivityAt).toBe(500);

    const idle = createInitialWatchdogState();
    expect(recordActivity(idle, 500)).toBe(idle);

    const cooling = enterCooldown(running, 800);
    expect(recordActivity(cooling, 900)).toBe(cooling);
  });

  it('armWatchdog resets the resume counter for a fresh user goal', () => {
    let state = armWatchdog(0);
    state = markResumed(state, 0);
    expect(state.resumeCount).toBe(1);
    const rearmed = armWatchdog(100);
    expect(rearmed.resumeCount).toBe(0);
    expect(rearmed.phase).toBe('running');
  });

  it('markResumed increments the counter and returns to running', () => {
    const cooling = enterCooldown(armWatchdog(0), 1000);
    const resumed = markResumed(cooling, 2000);
    expect(resumed.phase).toBe('running');
    expect(resumed.resumeCount).toBe(1);
    expect(resumed.lastActivityAt).toBe(2000);
  });

  it('disarmWatchdog returns to the idle initial state', () => {
    expect(disarmWatchdog()).toEqual(createInitialWatchdogState());
  });

  it('full stall→resume→stall→giveup cycle respects the cap', () => {
    let state = armWatchdog(0);
    // First stall
    expect(evaluateWatchdog(state, 1000, CONFIG)).toEqual({ type: 'stop' });
    state = enterCooldown(state, 1000);
    expect(evaluateWatchdog(state, 1500, CONFIG)).toEqual({ type: 'resume' });
    state = markResumed(state, 1500); // resumeCount 1
    // Second stall
    expect(evaluateWatchdog(state, 2500, CONFIG)).toEqual({ type: 'stop' });
    state = enterCooldown(state, 2500);
    expect(evaluateWatchdog(state, 3000, CONFIG)).toEqual({ type: 'resume' });
    state = markResumed(state, 3000); // resumeCount 2 === cap
    // Third stall → cannot resume anymore
    expect(evaluateWatchdog(state, 4000, CONFIG)).toEqual({ type: 'giveup' });
  });
});
