/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `dbAnalyze` — pure helpers for the **data-analysis** layer of the IDE Database
 * feature: turning a connected SQL database's table into a statistical profile a
 * developer can read at a glance (fill rate, cardinality, numeric spread, top
 * values). It is the in-app answer to "what does this table actually contain?"
 * without hand-writing `COUNT(*)` / `GROUP BY` probes.
 *
 * The module is deliberately ENGINE-AGNOSTIC and SIDE-EFFECT-FREE: it only
 * *builds* the SQL strings (using a quoting function per engine) and *shapes*
 * the rows the driver returns back into {@link DbColumnProfile}s. The service
 * layer runs the actual queries through the existing read-only driver, so a
 * profile can never mutate data and is unit-testable without a database.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import type { DbColumn, DbColumnProfile, DbKind, DbQueryResult } from './dbTypes';

/** Default cap on rows scanned when profiling a large table. */
export const DEFAULT_PROFILE_SAMPLE = 50_000;

/** Default number of top frequent values fetched for a low-cardinality column. */
export const DEFAULT_TOP_VALUES = 8;

/** A column is treated as "unique-ish" (skip top-values) when distinct/total exceeds this. */
const HIGH_CARDINALITY_RATIO = 0.9;

/** Quote an identifier for an engine (double-quote for sqlite/pg/d1, backtick for mysql). */
export const quoteIdentFor =
  (kind: DbKind) =>
  (name: string): string =>
    kind === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`;

/** A schema-qualified, safely-quoted table reference. */
export const quoteTableFor = (kind: DbKind, table: string, schema?: string): string => {
  const q = quoteIdentFor(kind);
  return schema ? `${q(schema)}.${q(table)}` : q(table);
};

/** Whether an engine-native column type reads as numeric (drives min/max/avg). */
export const isNumericType = (type: string): boolean =>
  /\b(int|integer|smallint|bigint|tinyint|mediumint|dec|decimal|numeric|real|double|float|money|number)\b/i.test(type);

/**
 * Build the single aggregate query that profiles ALL columns of a table at once:
 * total rows, and per-column NULL count + DISTINCT count (+ MIN/MAX/AVG for
 * numeric columns). One round-trip keeps profiling cheap even for wide tables.
 *
 * Returns the SQL plus the ordered list of result columns so the caller can map
 * the single result row back to per-column stats deterministically.
 */
export const buildProfileQuery = (
  kind: DbKind,
  table: string,
  schema: string | undefined,
  columns: DbColumn[],
  sampleLimit: number
): { sql: string; selectMeta: Array<{ column: string; type: string; numeric: boolean }> } => {
  const q = quoteIdentFor(kind);
  const tableRef = quoteTableFor(kind, table, schema);
  const selectMeta = columns.map((c) => ({ column: c.name, type: c.type, numeric: isNumericType(c.type) }));
  const aggregates: string[] = ['COUNT(*) AS total_rows'];
  for (const c of selectMeta) {
    const col = q(c.column);
    // SUM(CASE WHEN col IS NULL …) is portable across sqlite/pg/mysql/d1.
    aggregates.push(`SUM(CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END) AS ${q(`${c.column}__nulls`)}`);
    aggregates.push(`COUNT(DISTINCT ${col}) AS ${q(`${c.column}__distinct`)}`);
    if (c.numeric) {
      aggregates.push(`MIN(${col}) AS ${q(`${c.column}__min`)}`);
      aggregates.push(`MAX(${col}) AS ${q(`${c.column}__max`)}`);
      aggregates.push(`AVG(${col}) AS ${q(`${c.column}__avg`)}`);
    }
  }
  // Profile a bounded sample (subquery with LIMIT) so a huge table can't stall.
  const inner = `SELECT * FROM ${tableRef} LIMIT ${Math.max(1, Math.floor(sampleLimit))}`;
  const sql = `SELECT ${aggregates.join(', ')} FROM (${inner}) AS sample`;
  return { sql, selectMeta };
};

/** Build a top-N frequent-values query for one column. */
export const buildTopValuesQuery = (
  kind: DbKind,
  table: string,
  schema: string | undefined,
  column: string,
  limit: number
): string => {
  const q = quoteIdentFor(kind);
  const tableRef = quoteTableFor(kind, table, schema);
  const col = q(column);
  return `SELECT ${col} AS value, COUNT(*) AS cnt FROM ${tableRef} WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY cnt DESC LIMIT ${Math.max(1, Math.floor(limit))}`;
};

/** Coerce a cell to a finite number or null (engines may return numerics as strings). */
const toNum = (value: string | number | boolean | null): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * Map the single aggregate result row back into per-column profiles. `topValues`
 * is filled later (separately) for low-cardinality columns; here it starts empty.
 */
export const parseProfileResult = (
  result: DbQueryResult,
  selectMeta: Array<{ column: string; type: string; numeric: boolean }>,
  sampled: boolean
): { total: number; profiles: DbColumnProfile[] } => {
  const row = result.rows[0] ?? [];
  const at = (name: string): string | number | boolean | null => {
    const i = result.columns.indexOf(name);
    return i >= 0 ? (row[i] ?? null) : null;
  };
  const total = toNum(at('total_rows')) ?? 0;
  const profiles = selectMeta.map((c): DbColumnProfile => {
    const nulls = toNum(at(`${c.column}__nulls`)) ?? 0;
    const distinct = toNum(at(`${c.column}__distinct`)) ?? 0;
    const profile: DbColumnProfile = {
      column: c.column,
      type: c.type,
      total,
      nulls,
      distinct,
      sampled,
      topValues: [],
    };
    if (c.numeric) {
      profile.min = toNum(at(`${c.column}__min`));
      profile.max = toNum(at(`${c.column}__max`));
      profile.avg = toNum(at(`${c.column}__avg`));
    }
    return profile;
  });
  return { total, profiles };
};

/**
 * Decide which columns are worth a top-values query: low-cardinality, non-empty,
 * not effectively unique. Avoids a wasteful GROUP BY on a primary key / unique
 * id column where every value occurs once.
 */
export const columnsWorthTopValues = (profiles: DbColumnProfile[]): string[] =>
  profiles
    .filter((p) => p.distinct > 0 && p.distinct < Math.max(2, p.total * HIGH_CARDINALITY_RATIO))
    .map((p) => p.column);

/** Shape a top-values query result into the `{ value, count }[]` a profile carries. */
export const parseTopValues = (
  result: DbQueryResult
): Array<{ value: string | number | boolean | null; count: number }> => {
  const valueIdx = result.columns.indexOf('value');
  const cntIdx = result.columns.indexOf('cnt');
  if (valueIdx < 0 || cntIdx < 0) return [];
  return result.rows.map((row) => ({ value: row[valueIdx] ?? null, count: toNum(row[cntIdx]) ?? 0 }));
};
