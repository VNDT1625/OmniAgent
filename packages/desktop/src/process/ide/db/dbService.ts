/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `dbService` — the single source of truth for the IDE Database feature, shared
 * by BOTH planes (the UI bridge + the agent-facing MCP server) so a connection
 * the user opens is the same one an agent queries (no drift, one lifecycle).
 *
 * Responsibilities:
 *   - own the {@link DbConnectionStore} (saved definitions + keychain secrets),
 *   - lazily open/cache one {@link DbDriver} per connection id,
 *   - expose connect / testConnection / listTables / getColumns / query / close,
 *   - enforce the read-only guard (driver-level) + a global statement row cap.
 *
 * The driver factory is injected (keyed by {@link DbKind}) so the service is
 * unit-testable with fake drivers — no real sqlite/pg/mysql needed in tests.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import type { DbDriver } from './dbDriver';
import { splitStatements } from './dbDriver';
import type { DbConnectionStore } from './dbConnectionStore';
import type {
  DbColumn,
  DbConnectionConfig,
  DbConnectionState,
  DbForeignKey,
  DbIndex,
  DbKind,
  DbQueryOptions,
  DbQueryResult,
  DbSchema,
  DbSchemaGraph,
  DbSchemaGraphTable,
  DbScriptResult,
  DbScriptStatementResult,
  DbTable,
  DbTableDetail,
} from './dbTypes';

/** Builds a driver for a resolved connection config (with password). */
export type DbDriverFactory = (config: DbConnectionConfig) => DbDriver;

/** Default cap on tables walked for the schema (ER) graph — keeps the diagram legible. */
export const DEFAULT_MAX_SCHEMA_TABLES = 60;

/** Injected collaborators for {@link createDbService}. */
export type DbServiceDeps = {
  /** Persistent connection store (definitions + secrets). */
  store: DbConnectionStore;
  /** Factory map: one driver builder per engine. */
  drivers: Record<DbKind, DbDriverFactory>;
};

/** The public service contract (shared by the bridge + the MCP server). */
export type DbService = {
  /** List saved connection definitions (no passwords), with live connected flag. */
  listConnections: (rootPath?: string) => Promise<DbConnectionState[]>;
  /** Save (add/update) a connection definition. */
  saveConnection: (config: DbConnectionConfig) => Promise<void>;
  /** Delete a connection (closes it first). */
  deleteConnection: (id: string) => Promise<void>;
  /** Open (or reuse) the live driver for a connection. */
  connect: (id: string) => Promise<void>;
  /** Test a connection config WITHOUT saving it. Returns ok/error. */
  testConnection: (config: DbConnectionConfig) => Promise<{ ok: boolean; error?: string }>;
  /** List tables/views for a connected database. */
  listTables: (id: string) => Promise<DbTable[]>;
  /** List the columns of one table. */
  getColumns: (id: string, table: string, schema?: string) => Promise<DbColumn[]>;
  /** List the indexes of one table. */
  getIndexes: (id: string, table: string, schema?: string) => Promise<DbIndex[]>;
  /** List the outgoing foreign keys of one table. */
  getForeignKeys: (id: string, table: string, schema?: string) => Promise<DbForeignKey[]>;
  /** Full detail of one table (columns + indexes + foreign keys) in one call. */
  getTableDetail: (id: string, table: string, schema?: string) => Promise<DbTableDetail>;
  /** Build a whole-schema ER graph (tables + columns + FK edges) for visualization. */
  getSchemaGraph: (id: string, maxTables?: number) => Promise<DbSchemaGraph>;
  /** Run a SQL statement against a connection. */
  query: (id: string, sql: string, options?: DbQueryOptions) => Promise<DbQueryResult>;
  /** Run a multi-statement SQL script (split on top-level `;`), stopping at the first error. */
  queryScript: (id: string, script: string, options?: DbQueryOptions) => Promise<DbScriptResult>;
  /** Close a live connection (definition stays saved). */
  close: (id: string) => Promise<void>;
  /** Close every live connection (teardown). */
  closeAll: () => Promise<void>;
};

/** One live, opened driver + the config it was opened with. */
type LiveConn = { driver: DbDriver; config: DbConnectionConfig };

/**
 * Create the {@link DbService}. Drivers are opened lazily on first use and
 * cached until `close`/`deleteConnection`. A failed connect is surfaced (and the
 * partial driver discarded) so the next attempt starts clean.
 */
export const createDbService = (deps: DbServiceDeps): DbService => {
  const live = new Map<string, LiveConn>();

  const openDriver = async (id: string): Promise<LiveConn> => {
    const existing = live.get(id);
    if (existing) return existing;
    const config = await deps.store.resolve(id);
    if (!config) throw new Error(`No saved database connection with id: ${id}`);
    const factory = deps.drivers[config.kind];
    if (!factory) throw new Error(`Unsupported database engine: ${config.kind}`);
    const driver = factory(config);
    try {
      await driver.connect();
    } catch (error) {
      await driver.close().catch((): undefined => undefined);
      throw error instanceof Error ? error : new Error(String(error));
    }
    const entry = { driver, config };
    live.set(id, entry);
    return entry;
  };

  const listConnections: DbService['listConnections'] = async (rootPath) => {
    const all = await deps.store.list();
    const scoped = rootPath ? all.filter((c) => !c.rootPath || c.rootPath === rootPath) : all;
    return scoped.map((config) => ({
      config,
      connected: live.has(config.id),
      lastError: undefined as string | undefined,
    }));
  };

  const saveConnection: DbService['saveConnection'] = (config) => deps.store.upsert(config);

  const deleteConnection: DbService['deleteConnection'] = async (id) => {
    await close(id);
    await deps.store.remove(id);
  };

  const connect: DbService['connect'] = async (id) => {
    await openDriver(id);
  };

  const testConnection: DbService['testConnection'] = async (config) => {
    const factory = deps.drivers[config.kind];
    if (!factory) return { ok: false, error: `Unsupported database engine: ${config.kind}` };
    const driver = factory(config);
    try {
      await driver.connect();
      await driver.getSchema();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      await driver.close().catch((): undefined => undefined);
    }
  };

  const listTables: DbService['listTables'] = async (id) => {
    const { driver } = await openDriver(id);
    const schema: DbSchema = await driver.getSchema();
    return schema.tables;
  };

  const getColumns: DbService['getColumns'] = async (id, table, schema) => {
    const { driver } = await openDriver(id);
    return driver.getColumns(table, schema);
  };

  const getIndexes: DbService['getIndexes'] = async (id, table, schema) => {
    const { driver } = await openDriver(id);
    return driver.getIndexes(table, schema);
  };

  const getForeignKeys: DbService['getForeignKeys'] = async (id, table, schema) => {
    const { driver } = await openDriver(id);
    return driver.getForeignKeys(table, schema);
  };

  const getTableDetail: DbService['getTableDetail'] = async (id, table, schema) => {
    const { driver } = await openDriver(id);
    const [columns, indexes, foreignKeys] = await Promise.all([
      driver.getColumns(table, schema),
      driver.getIndexes(table, schema),
      driver.getForeignKeys(table, schema),
    ]);
    return { columns, indexes, foreignKeys };
  };

  const getSchemaGraph: DbService['getSchemaGraph'] = async (id, maxTables) => {
    const { driver } = await openDriver(id);
    const schema = await driver.getSchema();
    const cap = maxTables && maxTables > 0 ? maxTables : DEFAULT_MAX_SCHEMA_TABLES;
    const truncated = schema.tables.length > cap;
    const picked = schema.tables.slice(0, cap);
    const tables: DbSchemaGraphTable[] = await Promise.all(
      picked.map(async (tb): Promise<DbSchemaGraphTable> => {
        const [columns, foreignKeys] = await Promise.all([
          driver.getColumns(tb.name, tb.schema).catch((): DbColumn[] => []),
          driver.getForeignKeys(tb.name, tb.schema).catch((): DbForeignKey[] => []),
        ]);
        return { schema: tb.schema, name: tb.name, type: tb.type, columns, foreignKeys };
      })
    );
    return { kind: schema.kind, tables, truncated };
  };

  const query: DbService['query'] = async (id, sql, options) => {
    const { driver } = await openDriver(id);
    return driver.query(sql, options);
  };

  const queryScript: DbService['queryScript'] = async (id, script, options) => {
    const { driver } = await openDriver(id);
    const statements = splitStatements(script);
    const results: DbScriptStatementResult[] = [];
    const started = Date.now();
    let aborted = false;
    for (const sql of statements) {
      try {
        // Statements MUST run sequentially: a script's later statements can
        // depend on earlier ones, and we stop at the first error. Parallelising
        // would break ordering + the abort-on-error contract.
        // eslint-disable-next-line no-await-in-loop
        const res = await driver.query(sql, options);
        results.push({ ...res, sql });
      } catch (error) {
        results.push({
          sql,
          columns: [],
          rows: [],
          durationMs: 0,
          truncated: false,
          error: error instanceof Error ? error.message : String(error),
        });
        aborted = true;
        break;
      }
    }
    return { statements: results, durationMs: Date.now() - started, aborted };
  };

  const close: DbService['close'] = async (id) => {
    const entry = live.get(id);
    if (entry) {
      await entry.driver.close().catch((): undefined => undefined);
      live.delete(id);
    }
  };

  const closeAll: DbService['closeAll'] = async () => {
    await Promise.all([...live.keys()].map((id) => close(id)));
  };

  return {
    listConnections,
    saveConnection,
    deleteConnection,
    connect,
    testConnection,
    listTables,
    getColumns,
    getIndexes,
    getForeignKeys,
    getTableDetail,
    getSchemaGraph,
    query,
    queryScript,
    close,
    closeAll,
  };
};
