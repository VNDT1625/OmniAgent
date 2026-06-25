/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared architectural-layer presentation constants for the IDE Understand
 * views (the knowledge-graph column layout, the C4 graph, and the detail rail).
 *
 * Extracted into a tiny dependency-free module so every view imports the same
 * palette + order without pulling in a sibling component (avoids import cycles
 * and keeps the colour source of truth in one place). These are categorical
 * data-viz hues — the only intentional hard-coded colours in the feature,
 * chosen as mid-tones legible on both light and dark themes.
 */

import type { ArchLayer } from '@process/ide/understandTypes';

/** Fixed display order of the eight architectural layers (left→right columns). */
export const LAYER_ORDER: ArchLayer[] = ['api', 'service', 'data', 'ui', 'util', 'config', 'test', 'unknown'];

/** Categorical layer→colour map (theme-agnostic, mid-tone). */
export const LAYER_COLORS: Record<ArchLayer, string> = {
  api: '#6366F1',
  service: '#10B981',
  data: '#F59E0B',
  ui: '#EC4899',
  util: '#06B6D4',
  config: '#8B5CF6',
  test: '#84CC16',
  unknown: '#94A3B8',
};
