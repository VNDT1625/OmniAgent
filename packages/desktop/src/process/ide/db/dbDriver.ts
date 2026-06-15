/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `dbDriver` — the engine-agnostic database driver contract + shared SQL safety
 * helpers used by every concrete driver (sqlite / postgres / mysql).
 *
 * A driver owns ONE live connection (or pool) and exposes a tiny surface:
 * connect, list the schema, run a statement, and close. The service layer
 * (`dbService.ts`) manages the lifecycle of many drivers keyed by connection id;
 * the drivers themselves stay dumb and synchronous-ish.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import type { DbColumn, DbForeignKey, DbIndex, DbQueryOptions, DbQueryResult, DbSchema } from './dbTypes';

/** Default hard cap on rows returned by a single query (UI + agent safety). */
export const DEFAULT_MAX_ROWS = 1000;

/** Default per-statement timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** The engine-agnostic driver contract. One instance == one connection/pool. */
export type DbDriver = {
  /** Open the underlying connection/pool. Throws on failure. */
  connect: () => Promise<void>;
  /** Introspect the schema (tables/views). */
  getSchema: () => Promise<DbSchema>;
  /** Introspect the columns of one table (schema optional, postgres). */
  getColumns: (table: string, schema?: string) => Promise<DbColumn[]>;
  /** Introspect the indexes of one table. */
  getIndexes: (table: string, schema?: string) => Promise<DbIndex[]>;
  /** Introspect the outgoing foreign keys of one table. */
  getForeignKeys: (table: string, schema?: string) => Promise<DbForeignKey[]>;
  /** Run one SQL statement. Enforces read-only + row cap per options. */
  query: (sql: string, options?: DbQueryOptions) => Promise<DbQueryResult>;
  /** Close the connection/pool (idempotent). */
  close: () => Promise<void>;
};

/**
 * Decide whether a SQL statement is a pure READ. Used to enforce the
 * `readOnly` guard on a connection. Conservative: anything we don't recognise
 * as a read is treated as a write (so it is REJECTED in read-only mode).
 *
 * Strips leading line/block comments + whitespace, then matches the first
 * keyword. Read keywords: SELECT, WITH (CTE), EXPLAIN, SHOW, PRAGMA, DESCRIBE,
 * DESC, TABLE (postgres `TABLE x`), VALUES.
 */
export const isReadOnlySql = (sql: string): boolean => {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/--[^\n]*/g, ' ') // line comments
    .trim();
  if (stripped.length === 0) return true; // empty == harmless
  const first = stripped.split(/[\s(]+/, 1)[0]?.toLowerCase() ?? '';
  const readKeywords = new Set(['select', 'with', 'explain', 'show', 'pragma', 'describe', 'desc', 'table', 'values']);
  // A `WITH ... ` CTE can still end in INSERT/UPDATE/DELETE; guard that.
  if (first === 'with' && /\b(insert|update|delete|merge)\b/i.test(stripped)) return false;
  return readKeywords.has(first);
};

/**
 * Find the FIRST non-read statement in a SQL script, or `null` when every
 * statement is a pure read. Splits on top-level semicolons first, so a script
 * like `SELECT 1; DROP TABLE x` is correctly flagged (the naive single-keyword
 * check on the whole string would have classified it as a harmless SELECT).
 *
 * This is the read-only guard every driver MUST use: some engines (notably
 * Postgres' simple-query protocol) execute ALL statements in one string, so a
 * trailing write would otherwise slip past a SELECT-prefixed script.
 */
export const findWriteStatement = (script: string): string | null => {
  for (const stmt of splitStatements(script)) {
    if (!isReadOnlySql(stmt)) return stmt;
  }
  return null;
};

/** Human-friendly error thrown when a write hits a read-only connection. */
export const READ_ONLY_ERROR =
  'This connection is read-only. Only SELECT/WITH/EXPLAIN/SHOW/PRAGMA statements are allowed.';

/**
 * Throw {@link READ_ONLY_ERROR} when `readOnly` is set and the `sql` script
 * contains any non-read statement. No-op when the connection allows writes.
 */
export const assertReadOnly = (sql: string, readOnly: boolean): void => {
  if (!readOnly) return;
  if (findWriteStatement(sql) !== null) throw new Error(READ_ONLY_ERROR);
};

/**
 * Split a SQL script into individual statements on top-level semicolons,
 * ignoring semicolons inside single/double quotes and comments. Good enough for
 * the IDE query surface (not a full SQL parser); empty fragments are dropped.
 */
export const splitStatements = (script: string): string[] => {
  const out: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    const next = script[i + 1];
    if (inLineComment) {
      buf += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      buf += ch;
      if (ch === '*' && next === '/') {
        buf += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (!inSingle && !inDouble && ch === '-' && next === '-') {
      inLineComment = true;
      buf += ch;
      continue;
    }
    if (!inSingle && !inDouble && ch === '/' && next === '*') {
      inBlockComment = true;
      buf += ch;
      continue;
    }
    if (!inDouble && ch === "'") inSingle = !inSingle;
    else if (!inSingle && ch === '"') inDouble = !inDouble;

    if (ch === ';' && !inSingle && !inDouble) {
      if (buf.trim().length > 0) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
};

/** Coerce an arbitrary DB cell value into the JSON-safe union the UI expects. */
export const normalizeCell = (value: unknown): string | number | boolean | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return `\\x${Buffer.from(value).toString('hex')}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/**
 * A loader seam for the native DB module a driver wraps (`better-sqlite3`,
 * `pg`, `mysql2/promise`). Production drivers `require` the real module lazily;
 * tests inject a fake so the driver logic (read-only guard, row cap, result
 * shaping, introspection SQL) is exercised without a real database engine.
 */
export type ModuleLoader<T> = () => T;
