/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { scheduleNavigationAfterPaint } from '@/renderer/components/layout/routeTransition';

describe('scheduleNavigationAfterPaint', () => {
  it('waits for two animation frames before mounting the next route', () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const navigate = vi.fn();

    scheduleNavigationAfterPaint(navigate, requestFrame, vi.fn());

    expect(navigate).not.toHaveBeenCalled();
    frames.shift()?.(0);
    expect(navigate).not.toHaveBeenCalled();
    frames.shift()?.(16);
    expect(navigate).toHaveBeenCalledOnce();
  });

  it('does not navigate when the pending transition is cancelled', () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const navigate = vi.fn();

    const cancel = scheduleNavigationAfterPaint(navigate, requestFrame, vi.fn());
    cancel();
    frames.shift()?.(0);

    expect(navigate).not.toHaveBeenCalled();
  });
});
