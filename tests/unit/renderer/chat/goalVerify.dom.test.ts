/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { clearGoalVerifyCommand, getGoalVerifyCommand, setGoalVerifyCommand } from '@/renderer/utils/chat/goalVerify';

const CID = 'conv-verify';

describe('goalVerify store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns null when no command is set', () => {
    expect(getGoalVerifyCommand(CID)).toBeNull();
  });

  it('persists and reads back the verify command', () => {
    setGoalVerifyCommand(CID, 'bunx tsc --noEmit');
    expect(getGoalVerifyCommand(CID)).toBe('bunx tsc --noEmit');
  });

  it('clears the command', () => {
    setGoalVerifyCommand(CID, 'npm test');
    clearGoalVerifyCommand(CID);
    expect(getGoalVerifyCommand(CID)).toBeNull();
  });

  it('isolates per conversation', () => {
    setGoalVerifyCommand(CID, 'npm test');
    expect(getGoalVerifyCommand('another')).toBeNull();
  });

  it('treats blank/whitespace as unset', () => {
    setGoalVerifyCommand(CID, '   ');
    expect(getGoalVerifyCommand(CID)).toBeNull();
  });
});
