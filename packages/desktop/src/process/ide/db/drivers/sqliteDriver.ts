/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SQLite {@link DbDriver} backed by `better-sqlite3` (already bundled + rebuilt
 * for Electron). Synchronous under the hood, wrapped in promises to satisfy the
 * async driver contract. Opens the database file the repo ships (e.g.
 * `prisma/dev.db`, `db.sqlite3`) read-only by default.
 *
 * The native module is loaded through an injectable {@link ModuleLoader} so the
 * driver logic is unit-testable with a fake `better-sqlite3`.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { DEFAULT_MAX_ROWS, isReadOnlySql, normalizeCell, type DbDriver, type ModuleLoader } from '../dbDriver';
import type {
  DbColumn,
  DbConnectionConfig,
  DbForeignKey,
  DbIndex,
  DbQueryOptions,
  DbQueryResult,
  DbSchema,
  DbTable,
} from '../dbTypes';

/** Minimal structural type for a `better-sqlite3` prepared statement. */
type SqliteStmt = {
  reader: boolean;
  columns: () => Array<{ name: string }>;
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => { changes: number };
  raw: (toggle: boolean) => unknown;
};

/** Minimal structural type for the `better-sqlite3` Database we rely on. */
type SqliteDb = {
  prepare: (sql: string) => SqliteStmt;
  pragma: (source: string) => unknown;
  close: () => void;
};

/** The `better-sqlite3` constructor shape. */
export type SqliteModule = new (path: string, opts?: { readonly?: boolean; fileMustExist?: boolean }) => SqliteDb;

/** Quote a SQLite identifier for safe interpolation into a PRAGMA. */
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Default loader: lazily `require('better-sqlite3')`. */
const defaultLoad: ModuleLoader<SqliteModule> = () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('better-sqlite3') as SqliteModule;
};

/** Create a SQLite driver for a connection config (must have `file`). */
export const createSqliteDriver = (
  config: DbConnectionConfig,
  load: ModuleLoader<SqliteModule> = defaultLoad
): DbDriver => {
  let db: SqliteDb | null = null;
  const readOnly = config.readOnly !== false;

  const connect = async (): Promise<void> => {
    if (db) return;
    const file = config.file?.trim();
    if (!file) throw new Error('A SQLite database file path is required.');
    const Database = load();
    db = new Database(file, { readonly: readOnly, fileMustExist: true });
  };

  const ensure = (): SqliteDb => {
    if (!db) throw new Error('SQLite connection is not open.');
    return db;
  };

  const getSchema = async (): Promise<DbSchema> => {
    const handle = ensure();
    const rows = handle
      .prepare(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as Array<{ name: string; type: string }>;
    const tables: DbTable[] = rows.map((r) => ({ name: r.name, type: r.type === 'view' ? 'view' : 'table' }));
    return { kind: 'sqlite', tables };
  };

  const getColumns = async (table: string): Promise<DbColumn[]> => {
    const handle = ensure();
    // `PRAGMA table_info` returns: cid, name, type, notnull, dflt_value, pk.
    const rows = handle.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    return rows.map((r) => ({
      name: r.name,
      type: r.type || 'unknown',
      nullable: r.notnull === 0,
      primaryKey: r.pk > 0,
    }));
  };

  const getIndexes = async (table: string): Promise<DbIndex[]> => {
    const handle = ensure();
    const list = handle.prepare(`PRAGMA index_list(${quoteIdent(table)})`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
    }>;
    return list.map((idx) => {
      const cols = handle.prepare(`PRAGMA index_info(${quoteIdent(idx.name)})`).all() as Array<{ name: string }>;
      return {
        name: idx.name,
        columns: cols.map((c) => c.name),
        unique: idx.unique === 1,
        primary: idx.origin === 'pk',
      };
    });
  };

  const getForeignKeys = async (table: string): Promise<DbForeignKey[]> => {
    const handle = ensure();
    // `PRAGMA foreign_key_list`: id, seq, table, from, to, on_update, on_delete, match.
    const rows = handle.prepare(`PRAGMA foreign_key_list(${quoteIdent(table)})`).all() as Array<{
      id: number;
      table: string;
      from: string;
      to: string;
    }>;
    const byId = new Map<number, DbForeignKey>();
    for (const r of rows) {
      const existing = byId.get(r.id);
      if (existing) {
        existing.columns.push(r.from);
        existing.referencedColumns.push(r.to);
      } else {
        byId.set(r.id, {
          name: `fk_${table}_${r.id}`,
          columns: [r.from],
          referencedTable: r.table,
          referencedColumns: [r.to],
        });
      }
    }
    return [...byId.values()];
  };

  const query = async (sql: string, options?: DbQueryOptions): Promise<DbQueryResult> => {
    const handle = ensure();
    if (readOnly && !isReadOnlySql(sql)) {
      throw new Error('This connection is read-only. Only SELECT/EXPLAIN/PRAGMA statements are allowed.');
    }
    const maxRows = options?.maxRows && options.maxRows > 0 ? options.maxRows : DEFAULT_MAX_ROWS;
    const params = options?.params ?? [];
    const started = Date.now();
    const stmt = handle.prepare(sql);

    if (stmt.reader) {
      const columns = stmt.columns().map((c) => c.name);
      stmt.raw(true);
      const allRows = stmt.all(...params) as unknown[][];
      const limited = allRows.slice(0, maxRows);
      const rows = limited.map((row) => row.map((cell) => normalizeCell(cell)));
      return {
        columns,
        rows,
        durationMs: Date.now() - started,
        truncated: allRows.length > maxRows,
      };
    }
    const info = stmt.run(...params);
    return { columns: [], rows: [], rowsAffected: info.changes, durationMs: Date.now() - started, truncated: false };
  };

  const close = async (): Promise<void> => {
    if (db) {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      db = null;
    }
  };

  return { connect, getSchema, getColumns, getIndexes, getForeignKeys, query, close };
};
