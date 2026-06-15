/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure date helpers + conflict detection for the Schedule tab. Renderer-only.
 */

import type { CalendarEvent } from '@process/manager/managerTypes';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the local day for `ts`. */
export const startOfDay = (ts: number): number => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Start of the local week (Monday) for `ts`. */
export const startOfWeek = (ts: number): number => {
  const d = new Date(startOfDay(ts));
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  return d.getTime();
};

/** The seven day-start timestamps of the week containing `ts`. */
export const weekDays = (ts: number): number[] => {
  const start = startOfWeek(ts);
  return Array.from({ length: 7 }, (_, i) => start + i * DAY_MS);
};

/** Events overlapping a [from, to) range, sorted by start. */
export const eventsInRange = (events: CalendarEvent[], from: number, to: number): CalendarEvent[] =>
  events.filter((e) => e.endAt > from && e.startAt < to).sort((a, b) => a.startAt - b.startAt);

/** Count overlapping event pairs in a list (for the conflict warning). */
export const countConflicts = (events: CalendarEvent[]): number => {
  const sorted = [...events].toSorted((a, b) => a.startAt - b.startAt);
  let conflicts = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (sorted[j].startAt >= sorted[i].endAt) break; // no later event can overlap i
      conflicts += 1;
    }
  }
  return conflicts;
};

/** Format a time range like "09:00–10:30". */
export const formatTimeRange = (startAt: number, endAt: number): string => {
  const fmt = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${fmt(startAt)}–${fmt(endAt)}`;
};
