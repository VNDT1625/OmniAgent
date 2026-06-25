/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { advanceComplianceState, createInitialComplianceState, decideCompliance, parseGoalStatus, type GoalComplianceConfig } from '@/common/chat/slash/goalCompliance';

const CONFIG: GoalComplianceConfig = { maxAutoTurns: 5, maxCorrections: 2 };

describe('parseGoalStatus', () => {
  it('parses a complete marker', () => {
    expect(parseGoalStatus('work...\n[[GOAL next=done tests=pass phase=8]]')).toEqual({ next: 'done', tests: 'pass', phase: 8 });
  });

  it('is case-insensitive and tolerant of spacing/field order', () => {
    expect(parseGoalStatus('[[ goal   tests = FAIL   next= continue ]]')).toEqual({ next: 'continue', tests: 'fail' });
  });

  it('defaults tests to none when omitted', () => {
    expect(parseGoalStatus('[[GOAL next=continue]]')).toEqual({ next: 'continue', tests: 'none' });
  });

  it('uses the LAST marker when several are present', () => {
    expect(parseGoalStatus('[[GOAL next=continue tests=none]] ... [[GOAL next=done tests=pass]]')).toEqual({ next: 'done', tests: 'pass' });
  });

  it('returns null when there is no marker or next is invalid', () => {
    expect(parseGoalStatus('no marker here')).toBeNull();
    expect(parseGoalStatus('[[GOAL tests=pass]]')).toBeNull();
    expect(parseGoalStatus('[[GOAL next=maybe tests=pass]]')).toBeNull();
    expect(parseGoalStatus('')).toBeNull();
  });
});

describe('decideCompliance', () => {
  const fresh = createInitialComplianceState();

  it('accepts only when done AND tests pass', () => {
    expect(decideCompliance({ next: 'done', tests: 'pass' }, fresh, CONFIG)).toEqual({ type: 'accept' });
  });

  it('rejects done when tests are not passing', () => {
    expect(decideCompliance({ next: 'done', tests: 'fail' }, fresh, CONFIG).type).toBe('reject');
    expect(decideCompliance({ next: 'done', tests: 'none' }, fresh, CONFIG).type).toBe('reject');
  });

  it('drives the next phase on continue', () => {
    expect(decideCompliance({ next: 'continue', tests: 'none' }, fresh, CONFIG).type).toBe('continue');
  });

  it('halts on blocked', () => {
    expect(decideCompliance({ next: 'blocked', tests: 'none' }, fresh, CONFIG)).toEqual({ type: 'halt', reason: 'blocked' });
  });

  it('corrects a missing marker until the correction cap, then halts', () => {
    expect(decideCompliance(null, { autoTurns: 0, corrections: 0 }, CONFIG).type).toBe('correct');
    expect(decideCompliance(null, { autoTurns: 2, corrections: 2 }, CONFIG)).toEqual({ type: 'halt', reason: 'max-corrections' });
  });

  it('halts when the auto-drive turn cap is reached', () => {
    expect(decideCompliance({ next: 'continue', tests: 'none' }, { autoTurns: 5, corrections: 0 }, CONFIG)).toEqual({ type: 'halt', reason: 'max-turns' });
  });
});

describe('advanceComplianceState', () => {
  it('counts a correction against both counters', () => {
    expect(advanceComplianceState({ autoTurns: 1, corrections: 1 }, { type: 'correct', prompt: 'x' })).toEqual({ autoTurns: 2, corrections: 2 });
  });

  it('resets corrections when continuing or rejecting', () => {
    expect(advanceComplianceState({ autoTurns: 1, corrections: 2 }, { type: 'continue', prompt: 'x' })).toEqual({ autoTurns: 2, corrections: 0 });
    expect(advanceComplianceState({ autoTurns: 1, corrections: 2 }, { type: 'reject', prompt: 'x' })).toEqual({ autoTurns: 2, corrections: 0 });
  });

  it('does not advance on accept or halt', () => {
    const s = { autoTurns: 3, corrections: 1 };
    expect(advanceComplianceState(s, { type: 'accept' })).toBe(s);
    expect(advanceComplianceState(s, { type: 'halt', reason: 'blocked' })).toBe(s);
  });
});
