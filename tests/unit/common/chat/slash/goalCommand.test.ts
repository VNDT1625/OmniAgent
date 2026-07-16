/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  expandGoalCommand,
  isGoalOffCommand,
  parseGoalCommand,
  parseGoalVerifyCommand,
} from '@/common/chat/slash/goalCommand';

describe('parseGoalCommand', () => {
  it('parses /goal with a requirement', () => {
    const parsed = parseGoalCommand('/goal build a login page');
    expect(parsed).toEqual({ variant: 'goal', requirement: 'build a login page' });
  });

  it('parses /goal-all and does not confuse it with /goal', () => {
    const parsed = parseGoalCommand('/goal-all ship the whole feature');
    expect(parsed).toEqual({ variant: 'goal-all', requirement: 'ship the whole feature' });
  });

  it('is case-insensitive and trims surrounding whitespace', () => {
    const parsed = parseGoalCommand('   /GOAL   refactor module   ');
    expect(parsed).toEqual({ variant: 'goal', requirement: 'refactor module' });
  });

  it('returns null for a goal command without a requirement', () => {
    expect(parseGoalCommand('/goal')).toBeNull();
    expect(parseGoalCommand('/goal   ')).toBeNull();
    expect(parseGoalCommand('/goal-all')).toBeNull();
  });

  it('returns null for non-goal input', () => {
    expect(parseGoalCommand('just a normal message')).toBeNull();
    expect(parseGoalCommand('/goalpost something')).toBeNull();
    expect(parseGoalCommand('')).toBeNull();
  });

  it('treats /goal off and /goal stop as control commands, not requirements', () => {
    expect(parseGoalCommand('/goal off')).toBeNull();
    expect(parseGoalCommand('/goal stop')).toBeNull();
    expect(parseGoalCommand('/goal-all off')).toBeNull();
  });

  it('treats /goal verify ... as a control command, not a requirement', () => {
    expect(parseGoalCommand('/goal verify bun run test')).toBeNull();
    expect(parseGoalCommand('/goal verify off')).toBeNull();
  });
});

describe('parseGoalVerifyCommand', () => {
  it('parses a set command', () => {
    expect(parseGoalVerifyCommand('/goal verify bunx tsc --noEmit')).toEqual({
      kind: 'set',
      command: 'bunx tsc --noEmit',
    });
    expect(parseGoalVerifyCommand('/goal-all verify npm test')).toEqual({ kind: 'set', command: 'npm test' });
  });

  it('parses clear variants (off/stop/clear/empty)', () => {
    expect(parseGoalVerifyCommand('/goal verify off')).toEqual({ kind: 'clear' });
    expect(parseGoalVerifyCommand('/goal verify stop')).toEqual({ kind: 'clear' });
    expect(parseGoalVerifyCommand('/goal verify')).toEqual({ kind: 'clear' });
  });

  it('returns null for non-verify input', () => {
    expect(parseGoalVerifyCommand('/goal build something')).toBeNull();
    expect(parseGoalVerifyCommand('hello')).toBeNull();
  });
});

describe('isGoalOffCommand', () => {
  it('detects deactivation commands (case-insensitive, trimmed)', () => {
    expect(isGoalOffCommand('/goal off')).toBe(true);
    expect(isGoalOffCommand('  /GOAL stop ')).toBe(true);
    expect(isGoalOffCommand('/goal-all off')).toBe(true);
  });

  it('does not treat a real goal requirement as a deactivation', () => {
    expect(isGoalOffCommand('/goal turn off the lights feature')).toBe(false);
    expect(isGoalOffCommand('/goal build it')).toBe(false);
    expect(isGoalOffCommand('off')).toBe(false);
  });
});

describe('expandGoalCommand', () => {
  it('returns null when input is not a goal command', () => {
    expect(expandGoalCommand('hello world')).toBeNull();
  });

  it('embeds the requirement and the mandatory pipeline for /goal', () => {
    const expanded = expandGoalCommand('/goal add pagination');
    expect(expanded).not.toBeNull();
    expect(expanded).toContain('add pagination');
    expect(expanded).toContain('QUY TRÌNH BẮT BUỘC 100%');
    // Should not advertise the stricter 101% goal-all framing.
    expect(expanded).not.toContain('101%');
  });

  it('keeps a blank line between the objective line and the intro', () => {
    const expanded = expandGoalCommand('/goal add pagination');
    expect(expanded).toContain('MỤC TIÊU (GOAL) của phiên này: add pagination\n\n');
  });

  it('uses the stricter full-autonomy framing for /goal-all', () => {
    const expanded = expandGoalCommand('/goal-all add pagination');
    expect(expanded).not.toBeNull();
    expect(expanded).toContain('add pagination');
    expect(expanded).toContain('101%');
    expect(expanded).toContain('QUY TRÌNH BẮT BUỘC 100%');
  });
});
