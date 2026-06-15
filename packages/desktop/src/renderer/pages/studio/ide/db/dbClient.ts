/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `dbClient` — renderer-side typed client for the IDE Database surface. Wraps
 * the `ide.db-*` IPC channels with a timeout guard so the UI never hangs if the
 * Main process is slow (a connect to a remote Postgres can stall). Mirrors the
 * other IDE clients (`ideClient`, `terminalBridgeClient`).
 *
 * Renderer-only module: it talks to the Main process exclusively through the
 * typed bridge — no Node.js APIs here.
 */

import { bridge } from '@office-ai/platform';
import {
  DB_CHANNELS,
  type DbColumnsRequest,
  type DbIdRequest,
  type DbListRequest,
  type DbQueryRequest,
  type DbQueryScriptRequest,
  type DbSaveRequest,
  type DbSchemaGraphRequest,
  type DbTableDetailRequest,
  type DbTablesRequest,
  type DbTestRequest,
} from '@process/ide/db/dbBridge';
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
} from '@process/ide/db/dbTypes';

/** Timeout (ms) for quick metadata ops (list/save/delete/tables/columns/close). */
const META_TIMEOUT_MS = 20_000;
/** Timeout (ms) for connect/test/query (a remote round-trip may be slow). */
const QUERY_TIMEOUT_MS = 60_000;

const channels = {
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

/** Race an invoke against a timeout so a stalled Main op surfaces as an error. */
const withTimeout = async <T>(label: string, run: () => Promise<DbResult<T>>, ms: number): Promise<DbResult<T>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DbResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `${label} timed out after ${ms}ms.` }), ms);
  });
  try {
    return await Promise.race([run(), timeout]);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** The renderer-facing Database client. */
export const dbClient = {
  list: (rootPath?: string): Promise<DbResult<DbConnectionState[]>> =>
    withTimeout('List connections', () => channels.list.invoke({ rootPath }), META_TIMEOUT_MS),
  save: (config: DbConnectionConfig): Promise<DbResult<boolean>> =>
    withTimeout('Save connection', () => channels.save.invoke({ config }), META_TIMEOUT_MS),
  delete: (id: string): Promise<DbResult<boolean>> =>
    withTimeout('Delete connection', () => channels.delete.invoke({ id }), META_TIMEOUT_MS),
  test: (config: DbConnectionConfig): Promise<DbResult<{ ok: boolean; error?: string }>> =>
    withTimeout('Test connection', () => channels.test.invoke({ config }), QUERY_TIMEOUT_MS),
  connect: (id: string): Promise<DbResult<boolean>> =>
    withTimeout('Connect', () => channels.connect.invoke({ id }), QUERY_TIMEOUT_MS),
  tables: (id: string): Promise<DbResult<DbTable[]>> =>
    withTimeout('List tables', () => channels.tables.invoke({ id }), META_TIMEOUT_MS),
  columns: (id: string, table: string, schema?: string): Promise<DbResult<DbColumn[]>> =>
    withTimeout('List columns', () => channels.columns.invoke({ id, table, schema }), META_TIMEOUT_MS),
  tableDetail: (id: string, table: string, schema?: string): Promise<DbResult<DbTableDetail>> =>
    withTimeout('Describe table', () => channels.tableDetail.invoke({ id, table, schema }), META_TIMEOUT_MS),
  schemaGraph: (id: string, maxTables?: number): Promise<DbResult<DbSchemaGraph>> =>
    withTimeout('Schema diagram', () => channels.schemaGraph.invoke({ id, maxTables }), QUERY_TIMEOUT_MS),
  query: (id: string, sql: string, options?: DbQueryOptions): Promise<DbResult<DbQueryResult>> =>
    withTimeout('Run query', () => channels.query.invoke({ id, sql, options }), QUERY_TIMEOUT_MS),
  queryScript: (id: string, script: string, options?: DbQueryOptions): Promise<DbResult<DbScriptResult>> =>
    withTimeout('Run script', () => channels.queryScript.invoke({ id, script, options }), QUERY_TIMEOUT_MS),
  close: (id: string): Promise<DbResult<boolean>> =>
    withTimeout('Close', () => channels.close.invoke({ id }), META_TIMEOUT_MS),
};

export type {
  DbColumn,
  DbConnectionConfig,
  DbConnectionState,
  DbForeignKey,
  DbIndex,
  DbQueryResult,
  DbSchemaGraph,
  DbSchemaGraphTable,
  DbScriptResult,
  DbTable,
  DbTableDetail,
} from '@process/ide/db/dbTypes';
