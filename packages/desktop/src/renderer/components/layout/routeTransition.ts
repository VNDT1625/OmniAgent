/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Let Chromium paint the route-loading indicator before mounting a potentially
 * expensive page. Two frames are intentional: React commits after the click,
 * the first frame paints that commit, and navigation starts on the next frame.
 */
export const scheduleNavigationAfterPaint = (
  navigate: () => void,
  requestFrame: (callback: FrameRequestCallback) => number = window.requestAnimationFrame.bind(window),
  cancelFrame: (handle: number) => void = window.cancelAnimationFrame.bind(window)
): (() => void) => {
  let cancelled = false;
  let firstFrame = 0;
  let secondFrame = 0;

  firstFrame = requestFrame(() => {
    if (cancelled) return;
    secondFrame = requestFrame(() => {
      if (!cancelled) navigate();
    });
  });

  return () => {
    cancelled = true;
    cancelFrame(firstFrame);
    if (secondFrame) cancelFrame(secondFrame);
  };
};
