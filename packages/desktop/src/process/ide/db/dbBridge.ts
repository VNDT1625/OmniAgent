/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `dbBridge` — the **UI plane** for the IDE Database surface. Exposes the shared
 * {@link DbService} to the renderer over always-resolving envelopes (so the
 * Database panel never hangs even when a connection fails). Channels:
 *
 *   - `ide.db-list`     → saved connections (+ live connected flag)
 *   - `ide.db-save`     → add/update a connection definition
 *   - `ide.db-delete`   → remove a connection
 *   - `ide.db-test`     → test a config without saving
 *   - `ide.db-connect`  → open the live connection
 *   - `ide.db-tables`   → list tables/views
 *   - `ide.db-columns`  → list a table's columns
 *   - `ide.db-query`    → run a SQL statement
 *   - `ide.db-close`    → close a live connection
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import type { DbService } from './dbService';
import type {
  DbColumn,
  DbConnectionConfig,
  DbConnectionState,
  DbQueryOptions,
  DbQueryResult,
  DbResult,
  DbSchemaGraph,
  DbScriptResult,
  DbTable,
  DbTableDetail,
} from './dbTypes';

/** IPC channel names for the IDE Database surface. */
export const DB_CHANNELS = {
  list: 'ide.db-list',
  save: 'ide.db-save',
  delete: 'ide.db-delete',
  test: 'ide.db-test',
  connect: 'ide.db-connect',
  tables: 'ide.db-tables',
  columns: 'ide.db-columns',
  tableDetail: 'ide.db-table-detail',
  schemaGraph: 'ide.db-schema-graph',
  query: 'ide.db-query',
  queryScript: 'ide.db-query-script',
  close: 'ide.db-close',
} as const;

/** Request shapes. */
export type DbListRequest = { rootPath?: string };
export type DbSaveRequest = { config: DbConnectionConfig };
export type DbIdRequest = { id: string };
export type DbTestRequest = { config: DbConnectionConfig };
export type DbTablesRequest = { id: string };
export type DbColumnsRequest = { id: string; table: string; schema?: string };
export type DbTableDetailRequest = { id: string; table: string; schema?: string };
export type DbSchemaGraphRequest = { id: string; maxTables?: number };
export type DbQueryRequest = { id: string; sql: string; options?: DbQueryOptions };
export type DbQueryScriptRequest = { id: string; script: string; options?: DbQueryOptions };

/** Typed channels. */
export const dbChannels = {
  list: bridge.buildProvider<DbResult<DbConnectionState[]>, DbListRequest>(DB_CHANNELS.list),
  save: bridge.buildProvider<DbResult<boolean>, DbSaveRequest>(DB_CHANNELS.save),
  delete: bridge.buildProvider<DbResult<boolean>, DbIdRequest>(DB_CHANNELS.delete),
  test: bridge.buildProvider<DbResult<{ ok: boolean; error?: string }>, DbTestRequest>(DB_CHANNELS.test),
  connect: bridge.buildProvider<DbResult<boolean>, DbIdRequest>(DB_CHANNELS.connect),
  tables: bridge.buildProvider<DbResult<DbTable[]>, DbTablesRequest>(DB_CHANNELS.tables),
  columns: bridge.buildProvider<DbResult<DbColumn[]>, DbColumnsRequest>(DB_CHANNELS.columns),
  tableDetail: bridge.buildProvider<DbResult<DbTableDetail>, DbTableDetailRequest>(DB_CHANNELS.tableDetail),
  schemaGraph: bridge.buildProvider<DbResult<DbSchemaGraph>, DbSchemaGraphRequest>(DB_CHANNELS.schemaGraph),
  query: bridge.buildProvider<DbResult<DbQueryResult>, DbQueryRequest>(DB_CHANNELS.query),
  queryScript: bridge.buildProvider<DbResult<DbScriptResult>, DbQueryScriptRequest>(DB_CHANNELS.queryScript),
  close: bridge.buildProvider<DbResult<boolean>, DbIdRequest>(DB_CHANNELS.close),
};

/** Injected collaborators for {@link registerDbBridge}. */
export type DbBridgeDeps = {
  /** The shared database service singleton. */
  service: DbService;
};

/** Wrap an async producer into an always-resolving {@link DbResult}. */
const guard = async <T>(fn: () => Promise<T>): Promise<DbResult<T>> => {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * Register the IDE Database IPC handlers. Idempotent. Called once during
 * Main-process bootstrap.
 */
export function registerDbBridge(deps: DbBridgeDeps): void {
  const { service } = deps;

  dbChannels.list.provider((req) => guard(() => service.listConnections(req.rootPath)));
  dbChannels.save.provider((req) => guard(async () => (await service.saveConnection(req.config), true)));
  dbChannels.delete.provider((req) => guard(async () => (await service.deleteConnection(req.id), true)));
  dbChannels.test.provider((req) => guard(() => service.testConnection(req.config)));
  dbChannels.connect.provider((req) => guard(async () => (await service.connect(req.id), true)));
  dbChannels.tables.provider((req) => guard(() => service.listTables(req.id)));
  dbChannels.columns.provider((req) => guard(() => service.getColumns(req.id, req.table, req.schema)));
  dbChannels.tableDetail.provider((req) => guard(() => service.getTableDetail(req.id, req.table, req.schema)));
  dbChannels.schemaGraph.provider((req) => guard(() => service.getSchemaGraph(req.id, req.maxTables)));
  dbChannels.query.provider((req) => guard(() => service.query(req.id, req.sql, req.options)));
  dbChannels.queryScript.provider((req) => guard(() => service.queryScript(req.id, req.script, req.options)));
  dbChannels.close.provider((req) => guard(async () => (await service.close(req.id), true)));
}
