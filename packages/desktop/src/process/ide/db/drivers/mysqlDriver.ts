/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MySQL / MariaDB {@link DbDriver} backed by `mysql2/promise`. Uses a connection
 * **pool** so a dropped idle connection (or a dockerised MySQL that restarts) is
 * transparently re-established on the next query. Schema introspection reads
 * `information_schema` scoped to the connection's database.
 *
 * The `mysql2/promise` module is loaded through an injectable
 * {@link ModuleLoader} so the driver logic is unit-testable with a fake pool.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import {
  DEFAULT_MAX_ROWS,
  DEFAULT_TIMEOUT_MS,
  isReadOnlySql,
  normalizeCell,
  type DbDriver,
  type ModuleLoader,
} from '../dbDriver';
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

/** Minimal structural type for the `mysql2/promise` pool we rely on. */
type MysqlPool = {
  query: (opts: {
    sql: string;
    values?: unknown[];
    rowsAsArray?: boolean;
    timeout?: number;
  }) => Promise<[unknown, Array<{ name: string }> | undefined]>;
  end: () => Promise<void>;
};

/** The `mysql2/promise` module shape we use. */
export type MysqlModule = { createPool: (cfg: Record<string, unknown>) => MysqlPool };

/** Default loader: lazily `require('mysql2/promise')`. */
const defaultLoad: ModuleLoader<MysqlModule> = () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('mysql2/promise') as MysqlModule;
};

/** Create a MySQL driver for a connection config. */
export const createMysqlDriver = (
  config: DbConnectionConfig,
  load: ModuleLoader<MysqlModule> = defaultLoad
): DbDriver => {
  let pool: MysqlPool | null = null;
  const readOnly = config.readOnly !== false;

  const connect = async (): Promise<void> => {
    if (pool) return;
    const mysql = load();
    const p = mysql.createPool({
      host: config.host ?? '127.0.0.1',
      port: config.port ?? 3306,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: 10_000,
      dateStrings: true,
      connectionLimit: 4,
      waitForConnections: true,
    });
    // Validate connectivity up-front so connect() throws on bad credentials/host.
    await p.query({ sql: 'SELECT 1' });
    pool = p;
  };

  const ensure = (): MysqlPool => {
    if (!pool) throw new Error('MySQL connection is not open.');
    return pool;
  };

  const getSchema = async (): Promise<DbSchema> => {
    const handle = ensure();
    const [rows] = await handle.query({
      sql: `SELECT table_name AS name, table_type AS type
            FROM information_schema.tables
            WHERE table_schema = DATABASE()
            ORDER BY table_name`,
    });
    const tables: DbTable[] = (rows as Array<{ name: string; type: string }>).map((r) => ({
      name: r.name,
      type: /view/i.test(r.type) ? 'view' : 'table',
    }));
    return { kind: 'mysql', tables };
  };

  const getColumns = async (table: string): Promise<DbColumn[]> => {
    const handle = ensure();
    const [rows] = await handle.query({
      sql: `SELECT column_name AS name, column_type AS type, is_nullable AS nullable, column_key AS ckey
            FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = ?
            ORDER BY ordinal_position`,
      values: [table],
    });
    return (rows as Array<{ name: string; type: string; nullable: string; ckey: string }>).map((r) => ({
      name: r.name,
      type: r.type,
      nullable: r.nullable === 'YES',
      primaryKey: r.ckey === 'PRI',
    }));
  };

  const getIndexes = async (table: string): Promise<DbIndex[]> => {
    const handle = ensure();
    const [rows] = await handle.query({
      sql: `SELECT index_name AS name, non_unique AS nonUnique, column_name AS col, seq_in_index AS seq
            FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = ?
            ORDER BY index_name, seq_in_index`,
      values: [table],
    });
    const byName = new Map<string, DbIndex>();
    for (const r of rows as Array<{ name: string; nonUnique: number; col: string }>) {
      const existing = byName.get(r.name);
      if (existing) existing.columns.push(r.col);
      else
        byName.set(r.name, {
          name: r.name,
          columns: [r.col],
          unique: Number(r.nonUnique) === 0,
          primary: r.name === 'PRIMARY',
        });
    }
    return [...byName.values()];
  };

  const getForeignKeys = async (table: string): Promise<DbForeignKey[]> => {
    const handle = ensure();
    const [rows] = await handle.query({
      sql: `SELECT constraint_name AS name, column_name AS col,
                   referenced_table_name AS refTable, referenced_column_name AS refCol,
                   ordinal_position AS ord
            FROM information_schema.key_column_usage
            WHERE table_schema = DATABASE() AND table_name = ? AND referenced_table_name IS NOT NULL
            ORDER BY constraint_name, ordinal_position`,
      values: [table],
    });
    const byName = new Map<string, DbForeignKey>();
    for (const r of rows as Array<{ name: string; col: string; refTable: string; refCol: string }>) {
      const existing = byName.get(r.name);
      if (existing) {
        existing.columns.push(r.col);
        existing.referencedColumns.push(r.refCol);
      } else {
        byName.set(r.name, {
          name: r.name,
          columns: [r.col],
          referencedTable: r.refTable,
          referencedColumns: [r.refCol],
        });
      }
    }
    return [...byName.values()];
  };

  const query = async (sql: string, options?: DbQueryOptions): Promise<DbQueryResult> => {
    const handle = ensure();
    if (readOnly && !isReadOnlySql(sql)) {
      throw new Error('This connection is read-only. Only SELECT/WITH/EXPLAIN/SHOW statements are allowed.');
    }
    const maxRows = options?.maxRows && options.maxRows > 0 ? options.maxRows : DEFAULT_MAX_ROWS;
    const started = Date.now();
    const [result, fields] = await handle.query({
      sql,
      values: options?.params,
      rowsAsArray: true,
      timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const durationMs = Date.now() - started;

    // A row-returning statement yields an array of row-arrays + field defs;
    // a write yields an OkPacket-like object (no fields).
    if (Array.isArray(result) && fields) {
      const columns = fields.map((f) => f.name);
      const allRows = result as unknown[][];
      const limited = allRows.slice(0, maxRows);
      const rows = limited.map((row) => row.map((cell) => normalizeCell(cell)));
      return { columns, rows, durationMs, truncated: allRows.length > maxRows };
    }
    const affected = (result as { affectedRows?: number })?.affectedRows ?? 0;
    return { columns: [], rows: [], rowsAffected: affected, durationMs, truncated: false };
  };

  const close = async (): Promise<void> => {
    if (pool) {
      try {
        await pool.end();
      } catch {
        /* already closed */
      }
      pool = null;
    }
  };

  return { connect, getSchema, getColumns, getIndexes, getForeignKeys, query, close };
};
