/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Cron } from 'croner';
import type { CoreScheduleSpec } from './types';

export const getNextCoreScheduleRunAt = (schedule: CoreScheduleSpec, afterMs: number): number | null => {
  if (schedule.kind === 'manual') return null;
  if (schedule.kind === 'interval') return afterMs + schedule.everyMs;
  if (schedule.kind === 'once') return schedule.at > afterMs ? schedule.at : null;
  validateTimeZone(schedule.timezone);
  const cron = new Cron(schedule.expression, { timezone: schedule.timezone, paused: true });
  try {
    return cron.nextRun(new Date(afterMs))?.getTime() ?? null;
  } finally {
    cron.stop();
  }
};

export const validateTimeZone = (timezone: string): void => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  } catch {
    throw new Error(`Invalid schedule timezone: ${timezone}`);
  }
};

export const validateCoreSchedule = (schedule: CoreScheduleSpec): void => {
  validateTimeZone(schedule.timezone);
  if (schedule.kind === 'manual') return;
  if (schedule.kind === 'interval') {
    if (!Number.isFinite(schedule.everyMs) || schedule.everyMs <= 0)
      throw new Error('Interval schedule duration must be positive.');
    return;
  }
  if (schedule.kind === 'once') {
    if (!Number.isFinite(schedule.at) || schedule.at <= 0) throw new Error('One-shot schedule time must be positive.');
    return;
  }
  if (!schedule.expression.trim()) throw new Error('Cron expression cannot be empty.');
  getNextCoreScheduleRunAt(schedule, Date.now());
};
