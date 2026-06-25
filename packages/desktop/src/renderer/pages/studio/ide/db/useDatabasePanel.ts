/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useDatabasePanel` — the data spine for the IDE Database panel. Owns the saved
 * connection list, the active connection + its schema, and the query runner,
 * talking to the Main process through {@link dbClient}. Pure React state; no
 * Node APIs (renderer boundary).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  dbClient,
  type DbColumn,
  type DbConnectionConfig,
  type DbConnectionState,
  type DbForeignKey,
  type DbIndex,
  type DbQueryResult,
  type DbTable,
} from './dbClient';

/** A table plus its lazily-loaded detail (columns + indexes + foreign keys). */
export type TableWithColumns = DbTable & {
  columns?: DbColumn[];
  indexes?: DbIndex[];
  foreignKeys?: DbForeignKey[];
  loadingColumns?: boolean;
};

/** Extract the error string from a failed result envelope (robust across TS narrowing). */
const resultError = (r: unknown): string =>
  typeof r === 'object' && r !== null && 'error' in r && typeof (r as { error?: unknown }).error === 'string'
    ? (r as { error: string }).error
    : 'Unknown error';

/** Public shape returned by {@link useDatabasePanel}. */
export type UseDatabasePanel = {
  connections: DbConnectionState[];
  activeId: string | null;
  tables: TableWithColumns[];
  loadingTables: boolean;
  result: DbQueryResult | null;
  running: boolean;
  error: string | null;
  refreshConnections: () => Promise<void>;
  selectConnection: (id: string) => Promise<void>;
  saveConnection: (config: DbConnectionConfig) => Promise<boolean>;
  deleteConnection: (id: string) => Promise<void>;
  testConnection: (config: DbConnectionConfig) => Promise<{ ok: boolean; error?: string }>;
  loadColumns: (table: TableWithColumns) => Promise<void>;
  runQuery: (sql: string) => Promise<void>;
  clearError: () => void;
};

/** Drive the IDE Database panel for a given repo root. */
export const useDatabasePanel = (rootPath: string | null): UseDatabasePanel => {
  const [connections, setConnections] = useState<DbConnectionState[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tables, setTables] = useState<TableWithColumns[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshConnections = useCallback(async (): Promise<void> => {
    const res = await dbClient.list(rootPath ?? undefined);
    if (!mountedRef.current) return;
    if (res.ok) setConnections(res.data);
    else setError(resultError(res));
  }, [rootPath]);

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

  const selectConnection = useCallback(
    async (id: string): Promise<void> => {
      setActiveId(id);
      setTables([]);
      setResult(null);
      setError(null);
      setLoadingTables(true);
      const connectRes = await dbClient.connect(id);
      if (!mountedRef.current) return;
      if (!connectRes.ok) {
        setError(resultError(connectRes));
        setLoadingTables(false);
        return;
      }
      const tablesRes = await dbClient.tables(id);
      if (!mountedRef.current) return;
      if (tablesRes.ok) setTables(tablesRes.data);
      else setError(resultError(tablesRes));
      setLoadingTables(false);
      void refreshConnections();
    },
    [refreshConnections]
  );

  const saveConnection = useCallback(
    async (config: DbConnectionConfig): Promise<boolean> => {
      const withRoot = { ...config, rootPath: config.rootPath ?? rootPath ?? undefined };
      const res = await dbClient.save(withRoot);
      if (!mountedRef.current) return false;
      if (!res.ok) {
        setError(resultError(res));
        return false;
      }
      await refreshConnections();
      return true;
    },
    [rootPath, refreshConnections]
  );

  const deleteConnection = useCallback(
    async (id: string): Promise<void> => {
      const res = await dbClient.delete(id);
      if (!mountedRef.current) return;
      if (!res.ok) {
        setError(resultError(res));
        return;
      }
      if (activeId === id) {
        setActiveId(null);
        setTables([]);
        setResult(null);
      }
      await refreshConnections();
    },
    [activeId, refreshConnections]
  );

  const testConnection = useCallback(
    (config: DbConnectionConfig): Promise<{ ok: boolean; error?: string }> =>
      dbClient.test(config).then((res) => (res.ok ? res.data : { ok: false, error: resultError(res) })),
    []
  );

  const loadColumns = useCallback(
    async (table: TableWithColumns): Promise<void> => {
      if (!activeId || table.columns || table.loadingColumns) return;
      setTables((prev) =>
        prev.map((t) => (t.name === table.name && t.schema === table.schema ? { ...t, loadingColumns: true } : t))
      );
      const res = await dbClient.tableDetail(activeId, table.name, table.schema);
      if (!mountedRef.current) return;
      setTables((prev) =>
        prev.map((t) =>
          t.name === table.name && t.schema === table.schema
            ? {
                ...t,
                loadingColumns: false,
                columns: res.ok ? res.data.columns : [],
                indexes: res.ok ? res.data.indexes : [],
                foreignKeys: res.ok ? res.data.foreignKeys : [],
              }
            : t
        )
      );
      if (!res.ok) setError(resultError(res));
    },
    [activeId]
  );

  const runQuery = useCallback(
    async (sql: string): Promise<void> => {
      if (!activeId || sql.trim().length === 0) return;
      setRunning(true);
      setError(null);
      // Run the editor content as a script: a single statement is just a
      // one-element script, while a multi-statement script runs each in order and
      // stops at the first error. We surface the last row-returning result.
      const res = await dbClient.queryScript(activeId, sql);
      if (!mountedRef.current) return;
      if (!res.ok) {
        setResult(null);
        setError(resultError(res));
        setRunning(false);
        return;
      }
      const { statements: stmts, aborted } = res.data;
      const failed = stmts.find((s) => s.error);
      const lastWithRows = stmts.toReversed().find((s) => s.columns.length > 0);
      const last = stmts[stmts.length - 1];
      setResult(lastWithRows ?? last ?? null);
      setError(aborted && failed?.error ? failed.error : null);
      setRunning(false);
    },
    [activeId]
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    connections,
    activeId,
    tables,
    loadingTables,
    result,
    running,
    error,
    refreshConnections,
    selectConnection,
    saveConnection,
    deleteConnection,
    testConnection,
    loadColumns,
    runQuery,
    clearError,
  };
};

export default useDatabasePanel;
