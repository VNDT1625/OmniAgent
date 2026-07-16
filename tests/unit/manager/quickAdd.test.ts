/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the natural-language quick-add task parser.
 */

import { describe, expect, it } from 'vitest';
import { parseQuickTask } from '@/renderer/pages/manager/tasks/quickAddParser';

// Fixed reference: Wed 2026-01-07 10:00 local.
const NOW = new Date(2026, 0, 7, 10, 0, 0).getTime();

describe('parseQuickTask', () => {
  it('extracts priority (EN + VI + pN) and strips it from the title', () => {
    expect(parseQuickTask('Write report !high', NOW).priority).toBe('high');
    expect(parseQuickTask('Nộp báo cáo !cao', NOW).priority).toBe('high');
    expect(parseQuickTask('urgent thing !khẩn', NOW).priority).toBe('urgent');
    expect(parseQuickTask('do it p1', NOW).priority).toBe('urgent');
    expect(parseQuickTask('Write report !high', NOW).title).toBe('Write report');
  });

  it('extracts #tags', () => {
    const r = parseQuickTask('Plan trip #travel #summer', NOW);
    expect(r.tags).toEqual(['travel', 'summer']);
    expect(r.title).toBe('Plan trip');
  });

  it('parses "tomorrow 5pm" into a due timestamp', () => {
    const r = parseQuickTask('Report tomorrow 5pm', NOW);
    const d = new Date(r.dueAt!);
    expect(d.getDate()).toBe(8); // next day
    expect(d.getHours()).toBe(17);
    expect(d.getMinutes()).toBe(0);
    expect(r.title).toBe('Report');
  });

  it('parses Vietnamese "mai 5pm"', () => {
    const r = parseQuickTask('Họp nhóm mai 5pm', NOW);
    const d = new Date(r.dueAt!);
    expect(d.getDate()).toBe(8);
    expect(d.getHours()).toBe(17);
  });

  it('parses 24h and "9h30" clock styles', () => {
    expect(new Date(parseQuickTask('Call 17:30', NOW).dueAt!).getHours()).toBe(17);
    expect(new Date(parseQuickTask('Call 17:30', NOW).dueAt!).getMinutes()).toBe(30);
    const h = parseQuickTask('Gym 9h30', NOW);
    expect(new Date(h.dueAt!).getHours()).toBe(9);
    expect(new Date(h.dueAt!).getMinutes()).toBe(30);
  });

  it('rolls a past time-only to tomorrow', () => {
    // 8am is before NOW (10am) → should be tomorrow 8am.
    const r = parseQuickTask('Standup 8am', NOW);
    const d = new Date(r.dueAt!);
    expect(d.getDate()).toBe(8);
    expect(d.getHours()).toBe(8);
  });

  it('resolves the next weekday', () => {
    // NOW is Wed (3). "Monday" → next Monday (the 12th).
    const r = parseQuickTask('Review Monday', NOW);
    const d = new Date(r.dueAt!);
    expect(d.getDay()).toBe(1);
    expect(d.getDate()).toBe(12);
  });

  it('combines priority + tags + due in one line', () => {
    const r = parseQuickTask('Nộp báo cáo quý mai 5pm !cao #work #report', NOW);
    expect(r.priority).toBe('high');
    expect(r.tags).toEqual(['work', 'report']);
    expect(new Date(r.dueAt!).getHours()).toBe(17);
    expect(r.title).toBe('Nộp báo cáo quý');
  });

  it('leaves a plain title untouched with no due', () => {
    const r = parseQuickTask('Buy milk', NOW);
    expect(r.title).toBe('Buy milk');
    expect(r.dueAt).toBeNull();
    expect(r.priority).toBeUndefined();
    expect(r.tags).toEqual([]);
  });
});
