/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ApplicablePreset, TaskKind } from '@process/resource/leaseTypes';

/**
 * Display order for the per-kind concurrency controls and the activity table.
 * Mirrors the `TaskKind` union in `leaseTypes.ts`; kept explicit so the UI order
 * is stable and intentional rather than dependent on object-key iteration.
 */
export const TASK_KINDS: TaskKind[] = [
  'agent',
  'browser',
  'emulator',
  'windowsTest',
  'patchBuild',
  'ocr',
  'transcription',
  'docConvert',
  'semanticIndex',
];

/**
 * Quick-level presets surfaced as buttons (criterion 5.3), in escalating order
 * of resource appetite.
 */
export const APPLICABLE_PRESETS: ApplicablePreset[] = ['saver', 'balanced', 'performance'];

/** i18n key for a task kind's human label, e.g. `resource.taskKind.agent`. */
export function taskKindLabelKey(kind: TaskKind): string {
  return `resource.taskKind.${kind}`;
}

/** i18n key for a preset's human label, e.g. `resource.preset.balanced`. */
export function presetLabelKey(preset: ApplicablePreset): string {
  return `resource.preset.${preset}`;
}

/**
 * Format a memory amount (MB) for display. Promotes to GB with one decimal once
 * the value reaches 1 GB so large ceilings stay readable.
 */
export function formatMemory(mb: number, mbUnit: string, gbUnit: string): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    // Trim a trailing ".0" so round values read as "8 GB" not "8.0 GB".
    const rounded = Math.round(gb * 10) / 10;
    return `${rounded} ${gbUnit}`;
  }
  return `${Math.round(mb)} ${mbUnit}`;
}
