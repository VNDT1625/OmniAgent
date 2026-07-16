/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildGoalSteering, GOAL_TURN_REMINDER } from '@/common/chat/slash/goalSteering';

describe('GOAL_TURN_REMINDER', () => {
  it('is a firm, self-contained steering reminder', () => {
    expect(GOAL_TURN_REMINDER).toContain('GOAL MODE');
    expect(GOAL_TURN_REMINDER).toContain('BẮT BUỘC');
    // References the off switch so the user always knows how to stop it.
    expect(GOAL_TURN_REMINDER).toContain('/goal off');
  });
});

describe('buildGoalSteering', () => {
  it('embeds the full mandatory pipeline for goal', () => {
    const steering = buildGoalSteering('goal');
    expect(steering).toContain('[GOAL MODE');
    expect(steering).toContain('QUY TRÌNH BẮT BUỘC 100%');
  });

  it('uses the stricter 101% framing for goal-all', () => {
    const steering = buildGoalSteering('goal-all');
    expect(steering).toContain('[GOAL-ALL MODE');
    expect(steering).toContain('101%');
    expect(steering).toContain('QUY TRÌNH BẮT BUỘC 100%');
  });
});
