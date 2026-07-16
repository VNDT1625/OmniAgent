/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Postgres {@link DbDriver} backed by `pg`. Uses a connection **Pool** (not a
 * single Client) so an idle connection dropped by the server — or a dockerised
 * Postgres that restarts — is transparently re-established on the next query
 * instead of throwing "Connection terminated". Schema introspection reads
 * `information_schema` + `pg_catalog`.
 *
 * The `pg` module is loaded through an injectable {@link ModuleLoader} so the
 * driver logic is unit-testable with a fake pool.
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

/** Minimal structural type for a `pg` Pool query result. */
type PgQueryResult = {
  fields: Array<{ name: string }>;
  rows: unknown[];
  rowCount: number | null;
  command: string;
};

/** Minimal structural type for the `pg` Pool we rely on. */
type PgPool = {
  query: (config: { text: string; values?: unknown[]; rowMode?: 'array' }) => Promise<PgQueryResult>;
  end: () => Promise<void>;
};

/** The `pg` module shape we use. */
export type PgModule = { Pool: new (cfg: Record<string, unknown>) => PgPool };

/** Default loader: lazily `require('pg')`. */
const defaultLoad: ModuleLoader<PgModule> = () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('pg') as PgModule;
};

/** Create a Postgres driver for a connection config. */
export const createPostgresDriver = (
  config: DbConnectionConfig,
  load: ModuleLoader<PgModule> = defaultLoad
): DbDriver => {
  let pool: PgPool | null = null;
  const readOnly = config.readOnly !== false;

  const connect = async (): Promise<void> => {
    if (pool) return;
    const pg = load();
    const p = new pg.Pool({
      host: config.host ?? '127.0.0.1',
      port: config.port ?? 5432,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      statement_timeout: DEFAULT_TIMEOUT_MS,
      connectionTimeoutMillis: 10_000,
      max: 4,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true,
    });
    // Validate connectivity up-front so connect() throws on bad credentials/host
    // (testConnection + the lazy-open path both rely on this).
    await p.query({ text: 'SELECT 1' });
    pool = p;
  };

  const ensure = (): PgPool => {
    if (!pool) throw new Error('Postgres connection is not open.');
    return pool;
  };

  const getSchema = async (): Promise<DbSchema> => {
    const handle = ensure();
    const res = await handle.query({
      text: `SELECT table_schema, table_name, table_type
             FROM information_schema.tables
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
             ORDER BY table_schema, table_name`,
    });
    const tables: DbTable[] = (res.rows as Array<{ table_schema: string; table_name: string; table_type: string }>).map(
      (r) => ({
        schema: r.table_schema,
        name: r.table_name,
        type: r.table_type === 'VIEW' ? 'view' : 'table',
      })
    );
    return { kind: 'postgres', tables };
  };

  const getColumns = async (table: string, schema?: string): Promise<DbColumn[]> => {
    const handle = ensure();
    const res = await handle.query({
      text: `SELECT c.column_name, c.data_type, c.is_nullable,
                    (pk.column_name IS NOT NULL) AS is_pk
             FROM information_schema.columns c
             LEFT JOIN (
               SELECT kcu.column_name, tc.table_schema, tc.table_name
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON kcu.constraint_name = tc.constraint_name
                AND kcu.table_schema = tc.table_schema
               WHERE tc.constraint_type = 'PRIMARY KEY'
             ) pk ON pk.column_name = c.column_name
                 AND pk.table_schema = c.table_schema
                 AND pk.table_name = c.table_name
             WHERE c.table_name = $1 AND c.table_schema = COALESCE($2, c.table_schema)
             ORDER BY c.ordinal_position`,
      values: [table, schema ?? null],
    });
    return (res.rows as Array<{ column_name: string; data_type: string; is_nullable: string; is_pk: boolean }>).map(
      (r) => ({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === 'YES',
        primaryKey: r.is_pk === true,
      })
    );
  };

  const getIndexes = async (table: string, schema?: string): Promise<DbIndex[]> => {
    const handle = ensure();
    const res = await handle.query({
      text: `SELECT i.relname AS name,
                    ix.indisunique AS is_unique,
                    ix.indisprimary AS is_primary,
                    a.attname AS column_name,
                    array_position(ix.indkey, a.attnum) AS ord
             FROM pg_class t
             JOIN pg_namespace n ON n.oid = t.relnamespace
             JOIN pg_index ix ON ix.indrelid = t.oid
             JOIN pg_class i ON i.oid = ix.indexrelid
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
             WHERE t.relname = $1 AND n.nspname = COALESCE($2, n.nspname)
             ORDER BY i.relname, ord`,
      values: [table, schema ?? null],
    });
    const byName = new Map<string, DbIndex>();
    for (const r of res.rows as Array<{ name: string; is_unique: boolean; is_primary: boolean; column_name: string }>) {
      const existing = byName.get(r.name);
      if (existing) existing.columns.push(r.column_name);
      else
        byName.set(r.name, {
          name: r.name,
          columns: [r.column_name],
          unique: r.is_unique === true,
          primary: r.is_primary === true,
        });
    }
    return [...byName.values()];
  };

  const getForeignKeys = async (table: string, schema?: string): Promise<DbForeignKey[]> => {
    const handle = ensure();
    const res = await handle.query({
      text: `SELECT tc.constraint_name AS name,
                    kcu.column_name AS column_name,
                    ccu.table_schema AS ref_schema,
                    ccu.table_name AS ref_table,
                    ccu.column_name AS ref_column,
                    kcu.ordinal_position AS ord
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
             JOIN information_schema.constraint_column_usage ccu
               ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
             WHERE tc.constraint_type = 'FOREIGN KEY'
               AND tc.table_name = $1 AND tc.table_schema = COALESCE($2, tc.table_schema)
             ORDER BY tc.constraint_name, ord`,
      values: [table, schema ?? null],
    });
    const byName = new Map<string, DbForeignKey>();
    for (const r of res.rows as Array<{
      name: string;
      column_name: string;
      ref_schema: string;
      ref_table: string;
      ref_column: string;
    }>) {
      const existing = byName.get(r.name);
      if (existing) {
        existing.columns.push(r.column_name);
        existing.referencedColumns.push(r.ref_column);
      } else {
        byName.set(r.name, {
          name: r.name,
          columns: [r.column_name],
          referencedSchema: r.ref_schema,
          referencedTable: r.ref_table,
          referencedColumns: [r.ref_column],
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
    const res = await handle.query({ text: sql, values: options?.params, rowMode: 'array' });
    const durationMs = Date.now() - started;
    const columns = res.fields.map((f) => f.name);
    const allRows = res.rows as unknown[][];
    const limited = allRows.slice(0, maxRows);
    const rows = limited.map((row) => row.map((cell) => normalizeCell(cell)));
    const isRead = columns.length > 0;
    return {
      columns,
      rows,
      rowsAffected: isRead ? undefined : (res.rowCount ?? 0),
      durationMs,
      truncated: allRows.length > maxRows,
    };
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
