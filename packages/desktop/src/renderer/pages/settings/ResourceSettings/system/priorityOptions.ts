/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-side priority constants for the System Insight process table.
 *
 * Mirrors the nice values in `process/system/processPriorityManager.ts` but is
 * kept dependency-free (no `node:os` import) so it is safe in the renderer. The
 * values are stable OS nice levels, so duplicating them here is low-risk.
 */

import type { ProcessPriorityLevel } from '@process/system/systemInfoTypes';

/** Selectable levels, ordered high → low for the dropdown. */
export const PRIORITY_LEVELS: ProcessPriorityLevel[] = ['high', 'aboveNormal', 'normal', 'belowNormal', 'low'];

/** Level → nice value (lower = higher priority). Must match the Main-process map. */
export const PRIORITY_NICE: Record<ProcessPriorityLevel, number> = {
  high: -14,
  aboveNormal: -7,
  normal: 0,
  belowNormal: 10,
  low: 19,
};

/** Map a raw nice value to the nearest level (for displaying current state). */
export const niceToLevel = (nice: number | null): ProcessPriorityLevel | null => {
  if (nice === null || !Number.isFinite(nice)) return null;
  let best: ProcessPriorityLevel = 'normal';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of PRIORITY_LEVELS) {
    const distance = Math.abs(PRIORITY_NICE[level] - nice);
    if (distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
};

/** i18n key for a level's human label, e.g. `system.priority.high`. */
export const priorityLabelKey = (level: ProcessPriorityLevel): string => `system.priority.${level}`;
