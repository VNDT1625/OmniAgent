/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers that turn a {@link DbQueryResult} into a simple chartable spec
 * for {@link ResultChart} — no chart library needed (the bar chart is rendered
 * as plain SVG). The job here is detection + projection: which columns are
 * numeric, and projecting a chosen label column + value column into aligned
 * `{ labels, values }` arrays (row-count capped). Side-effect-free + dependency
 * free so it is trivially unit-testable. Renderer-only concern.
 */

import type { DbQueryResult } from './dbClient';

/** A label + numeric value series ready to plot. */
export type ChartSpec = {
  labels: string[];
  values: number[];
  /** True when the rows were capped at {@link MAX_BARS}. */
  truncated: boolean;
};

/** Hard cap on bars so a huge result stays legible (and cheap to render). */
export const MAX_BARS = 50;

/** Coerce a cell to a finite number, or `null` when it isn't numeric. */
export const toNumber = (value: string | number | boolean | null): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * Indices of columns that are numeric: every non-null cell parses to a finite
 * number and there is at least one such value. (Booleans are not charted.)
 */
export const numericColumnIndices = (result: DbQueryResult): number[] => {
  const out: number[] = [];
  for (let c = 0; c < result.columns.length; c += 1) {
    let sawNumber = false;
    let allNumeric = true;
    for (const row of result.rows) {
      const cell = row[c];
      if (cell === null) continue;
      if (typeof cell === 'boolean') {
        allNumeric = false;
        break;
      }
      if (toNumber(cell) === null) {
        allNumeric = false;
        break;
      }
      sawNumber = true;
    }
    if (allNumeric && sawNumber) out.push(c);
  }
  return out;
};

/** Whether a result can be charted at all (has ≥1 numeric column + ≥1 row). */
export const isChartable = (result: DbQueryResult): boolean =>
  result.rows.length > 0 && numericColumnIndices(result).length > 0;

/**
 * Project a chosen label column + value column into a {@link ChartSpec}. Rows
 * whose value cell isn't numeric are skipped; the series is capped at
 * {@link MAX_BARS}. `labelIndex < 0` uses the 1-based row number as the label.
 */
export const buildChartSpec = (result: DbQueryResult, labelIndex: number, valueIndex: number): ChartSpec => {
  const labels: string[] = [];
  const values: number[] = [];
  for (let i = 0; i < result.rows.length; i += 1) {
    const row = result.rows[i];
    const value = toNumber(row[valueIndex] ?? null);
    if (value === null) continue;
    const labelCell = labelIndex >= 0 ? row[labelIndex] : i + 1;
    labels.push(labelCell === null ? '∅' : String(labelCell));
    values.push(value);
    if (values.length >= MAX_BARS) break;
  }
  return { labels, values, truncated: result.rows.length > values.length && values.length >= MAX_BARS };
};
