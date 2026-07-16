/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Presentation helpers for the Manager UI: map task/event enums to i18n keys,
 * semantic colour tokens (never hardcoded hex), and `@icon-park/react` icon
 * names. Pure + renderer-only so views stay declarative and consistent.
 */

import type { EventLockKind, Priority, TaskKind, TaskStatus } from '@process/manager/managerTypes';

/** Arco/Uno semantic colour token (success/warning/danger/primary/info). */
export type SemanticColor = 'success' | 'warning' | 'danger' | 'primary' | 'info';

/** Priority → semantic colour. Calm low end, urgent stands out (criterion 4.2). */
export const priorityColor = (p: Priority): SemanticColor => {
  switch (p) {
    case 'urgent':
      return 'danger';
    case 'high':
      return 'warning';
    case 'medium':
      return 'primary';
    case 'low':
    default:
      return 'info';
  }
};

/** Priority → i18n key under `manager.priority.*`. */
export const priorityKey = (p: Priority): string => `manager.priority.${p}`;

/** Task kind → `@icon-park/react` icon name. */
export const taskKindIcon = (kind: TaskKind): string => {
  switch (kind) {
    case 'recurring':
      return 'Refresh';
    case 'habit':
      return 'Lightning';
    case 'milestone':
      return 'Flag';
    case 'oneoff':
    default:
      return 'Calendar';
  }
};

/** Task kind → i18n key under `manager.kind.*`. */
export const taskKindKey = (kind: TaskKind): string => `manager.kind.${kind}`;

/** Status → i18n key under `manager.status.*`. */
export const statusKey = (status: TaskStatus): string => `manager.status.${status}`;

/** Event lock kind → semantic colour (fixed = warning/locked, flexible = primary). */
export const lockColor = (lock: EventLockKind): SemanticColor => (lock === 'fixed' ? 'warning' : 'primary');

/** All task kinds in display order (for filters + selects). */
export const TASK_KINDS: readonly TaskKind[] = ['oneoff', 'recurring', 'habit', 'milestone'];
/** All priorities in display order. */
export const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'medium', 'low'];
/** All statuses in display order. */
export const STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'done'];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the local day containing `ts` (ms epoch). */
export const startOfDay = (ts: number): number => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Whether `ts` falls on the same local day as `ref`. */
export const isSameDay = (ts: number, ref: number): boolean => startOfDay(ts) === startOfDay(ref);

/** Whether a due timestamp is today or earlier (i.e. due now). */
export const isDueToday = (dueAt: number | null | undefined, now: number): boolean =>
  dueAt != null && dueAt <= startOfDay(now) + DAY_MS - 1;

/** Whether a due timestamp is strictly in the past (overdue). */
export const isOverdue = (dueAt: number | null | undefined, now: number): boolean => dueAt != null && dueAt < now;
