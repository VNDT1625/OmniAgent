/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `dbExport` — pure formatters that turn a {@link DbQueryResult} into the two
 * formats people actually want out of a query tool: CSV (for spreadsheets) and
 * JSON (an array of row objects). Kept dependency-free + side-effect-free so the
 * renderer can call them directly to build a download and the agent plane can
 * reuse them too.
 */

import type { DbQueryResult } from './dbTypes';

/** RFC-4180-ish CSV escaping: quote when the cell holds a comma, quote, or newline. */
const escapeCsvCell = (value: string | number | boolean | null): string => {
  if (value === null) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
};

/**
 * Render a query result as CSV (header row + data rows). Uses CRLF line endings
 * so Excel imports cleanly. Returns just the header line when there are no rows.
 */
export const toCsv = (result: DbQueryResult): string => {
  const header = result.columns.map(escapeCsvCell).join(',');
  const lines = result.rows.map((row) => row.map(escapeCsvCell).join(','));
  return [header, ...lines].join('\r\n');
};

/**
 * Render a query result as a JSON array of row objects (`column -> value`),
 * pretty-printed. Duplicate column names are disambiguated with a `__N` suffix
 * so no data is silently dropped.
 */
export const toJson = (result: DbQueryResult): string => {
  const keys = dedupeColumns(result.columns);
  const objects = result.rows.map((row) => {
    const obj: Record<string, string | number | boolean | null> = {};
    keys.forEach((key, i) => {
      obj[key] = row[i] ?? null;
    });
    return obj;
  });
  return JSON.stringify(objects, null, 2);
};

/** Make column names unique (append `__2`, `__3`, … to later duplicates). */
const dedupeColumns = (columns: string[]): string[] => {
  const seen = new Map<string, number>();
  return columns.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name}__${count + 1}`;
  });
};
