/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { clearGoalMode, getGoalMode, isGoalModeActive, setGoalMode, withGoalSteeringDirective } from '@/renderer/utils/chat/goalMode';

const CID = 'conv-1';

describe('goalMode store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('is inactive by default', () => {
    expect(isGoalModeActive(CID)).toBe(false);
    expect(getGoalMode(CID)).toBeNull();
  });

  it('activates and persists the variant + requirement', () => {
    setGoalMode(CID, 'goal-all', 'ship the feature');
    expect(isGoalModeActive(CID)).toBe(true);
    const state = getGoalMode(CID);
    expect(state?.variant).toBe('goal-all');
    expect(state?.requirement).toBe('ship the feature');
  });

  it('clears Goal Mode', () => {
    setGoalMode(CID, 'goal', 'do it');
    clearGoalMode(CID);
    expect(isGoalModeActive(CID)).toBe(false);
  });

  it('isolates state per conversation', () => {
    setGoalMode(CID, 'goal', 'a');
    expect(isGoalModeActive('other-conv')).toBe(false);
  });
});

describe('withGoalSteeringDirective', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns input unchanged when Goal Mode is off', () => {
    expect(withGoalSteeringDirective('hello', CID)).toBe('hello');
  });

  it('prepends the binding steering reminder on ordinary turns when active', () => {
    setGoalMode(CID, 'goal', 'x');
    const out = withGoalSteeringDirective('please continue', CID);
    expect(out).toContain('GOAL MODE');
    expect(out).toContain('please continue');
    expect(out.startsWith('[GOAL MODE')).toBe(true);
  });

  it('does not inject into slash commands', () => {
    setGoalMode(CID, 'goal', 'x');
    expect(withGoalSteeringDirective('/execute @plan', CID)).toBe('/execute @plan');
  });

  it('does not double-inject when the message already carries goal steering', () => {
    setGoalMode(CID, 'goal', 'x');
    const already = 'MỤC TIÊU (GOAL) của phiên này: x';
    expect(withGoalSteeringDirective(already, CID)).toBe(already);
  });

  it('leaves empty messages untouched', () => {
    setGoalMode(CID, 'goal', 'x');
    expect(withGoalSteeringDirective('   ', CID)).toBe('   ');
  });
});
