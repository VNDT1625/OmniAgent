/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Natural-language quick-add parser for tasks (Todoist-class). Turns a single
 * line like:
 *
 *   "Nộp báo cáo quý mai 5pm !cao #work #report"
 *   "Call dentist tomorrow 9am !high #health"
 *
 * into a structured {@link QuickTask} — instantly, no AI round-trip. It extracts
 * (and strips from the title):
 * - **Priority**: `!urgent|!high|!medium|!low` (EN) or `!khẩn|!cao|!vừa|!thấp` (VI),
 *   plus `p1..p4` shorthand.
 * - **Tags**: `#tag` tokens.
 * - **Due date/time**: a small set of common phrases — today/tomorrow (+ VI
 *   "hôm nay"/"mai"/"ngày mai"), weekday names (EN + VI "thứ 2".."thứ 7","cn"),
 *   and a clock time ("5pm", "17:30", "9h", "9h30"). Unmatched text stays in the
 *   title.
 *
 * Pure + renderer-only. Deterministic given a `now` (injectable for tests).
 */

import type { Priority } from '@process/manager/managerTypes';

/** The structured result of parsing a quick-add line. */
export type QuickTask = {
  title: string;
  priority?: Priority;
  tags: string[];
  dueAt: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Priority keyword → value (English + Vietnamese + p1..p4). */
const PRIORITY_WORDS: Record<string, Priority> = {
  urgent: 'urgent',
  khan: 'urgent',
  khẩn: 'urgent',
  high: 'high',
  cao: 'high',
  medium: 'medium',
  med: 'medium',
  vừa: 'medium',
  vua: 'medium',
  low: 'low',
  thấp: 'low',
  thap: 'low',
  p1: 'urgent',
  p2: 'high',
  p3: 'medium',
  p4: 'low',
};

/** Weekday name → 0(Sun)..6(Sat). English + common Vietnamese forms. */
const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  cn: 0,
  'chủ nhật': 0,
  monday: 1,
  mon: 1,
  t2: 1,
  'thứ 2': 1,
  'thu 2': 1,
  tuesday: 2,
  tue: 2,
  t3: 2,
  'thứ 3': 2,
  'thu 3': 2,
  wednesday: 3,
  wed: 3,
  t4: 3,
  'thứ 4': 3,
  'thu 4': 3,
  thursday: 4,
  thu: 4,
  t5: 4,
  'thứ 5': 4,
  friday: 5,
  fri: 5,
  t6: 5,
  'thứ 6': 5,
  'thu 6': 5,
  saturday: 6,
  sat: 6,
  t7: 6,
  'thứ 7': 6,
  'thu 7': 6,
};

const setClock = (base: Date, hours: number, minutes: number): number => {
  const d = new Date(base);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
};

/** Next occurrence (today or future) of a weekday at local midnight. */
const nextWeekday = (now: Date, target: number): Date => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const diff = (target - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + (diff === 0 ? 7 : diff));
  return d;
};

/**
 * Parse a quick-add line. `now` defaults to the current time; inject for tests.
 */
export const parseQuickTask = (raw: string, now: number = Date.now()): QuickTask => {
  let text = ` ${raw.trim()} `;
  const tags: string[] = [];
  let priority: Priority | undefined;
  let dueDate: Date | null = null; // date part (midnight)
  let clock: { h: number; m: number } | null = null;

  // --- Tags: #tag ---------------------------------------------------------
  text = text.replace(/\s#([\p{L}\p{N}_-]+)/gu, (_m, tag: string) => {
    tags.push(tag);
    return ' ';
  });

  // --- Priority: !word or pN ---------------------------------------------
  text = text.replace(/\s!([\p{L}]+)/giu, (m, word: string) => {
    const p = PRIORITY_WORDS[word.toLowerCase()];
    if (p) {
      priority = p;
      return ' ';
    }
    return m;
  });
  text = text.replace(/\s(p[1-4])\b/gi, (m, word: string) => {
    const p = PRIORITY_WORDS[word.toLowerCase()];
    if (p) {
      priority = p;
      return ' ';
    }
    return m;
  });

  const lower = () => text.toLowerCase();
  const base = new Date(now);

  // --- Relative day words -------------------------------------------------
  const dayPhrases: Array<{ re: RegExp; days: number }> = [
    { re: /\b(today|hôm nay|hom nay)\b/iu, days: 0 },
    { re: /\b(tomorrow|tmr|ngày mai|ngay mai|mai)\b/iu, days: 1 },
    { re: /\b(day after tomorrow|ngày kia|ngay kia|mốt|mot)\b/iu, days: 2 },
  ];
  for (const { re, days } of dayPhrases) {
    if (re.test(lower())) {
      const d = new Date(base);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + days);
      dueDate = d;
      text = text.replace(re, ' ');
      break;
    }
  }

  // --- Weekday names (only if no relative day matched) --------------------
  if (!dueDate) {
    for (const [name, target] of Object.entries(WEEKDAYS)) {
      const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'iu');
      if (re.test(lower())) {
        dueDate = nextWeekday(base, target);
        text = text.replace(re, ' ');
        break;
      }
    }
  }

  // --- Clock time: 5pm / 17:30 / 9h / 9h30 --------------------------------
  const ampm = lower().match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  const h24 = lower().match(/\b(\d{1,2}):(\d{2})\b/);
  const hStyle = lower().match(/\b(\d{1,2})h(\d{2})?\b/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10) % 12;
    if (/pm/i.test(ampm[3])) h += 12;
    clock = { h, m: ampm[2] ? parseInt(ampm[2], 10) : 0 };
    text = text.replace(ampm[0], ' ');
  } else if (h24) {
    clock = { h: parseInt(h24[1], 10), m: parseInt(h24[2], 10) };
    text = text.replace(h24[0], ' ');
  } else if (hStyle) {
    clock = { h: parseInt(hStyle[1], 10), m: hStyle[2] ? parseInt(hStyle[2], 10) : 0 };
    text = text.replace(hStyle[0], ' ');
  }

  // --- Compose dueAt ------------------------------------------------------
  let dueAt: number | null = null;
  if (dueDate && clock) {
    dueAt = setClock(dueDate, clock.h, clock.m);
  } else if (dueDate) {
    dueAt = dueDate.getTime();
  } else if (clock) {
    // Time only → today, or tomorrow if already past.
    let t = setClock(base, clock.h, clock.m);
    if (t < now) t += DAY_MS;
    dueAt = t;
  }

  const title = text.replace(/\s+/g, ' ').trim();
  return { title, priority, tags, dueAt };
};
