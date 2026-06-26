/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cloudflare **D1** {@link DbDriver}. D1 is SQLite-as-a-service: the engine and
 * SQL dialect are identical to local SQLite, but the connection is an HTTPS REST
 * call to Cloudflare's API instead of a native module. That makes it a perfect
 * fit for this surface — the read-only guard, row cap, and result shaping are
 * the SAME as the local SQLite driver; only the transport differs.
 *
 * Endpoint (per connection):
 *   POST https://api.cloudflare.com/client/v4/accounts/{accountId}/d1/database/{databaseId}/query
 *   Authorization: Bearer {apiToken}
 *   body: { sql, params }
 *
 * No native module, no extra dependency: the HTTP layer is `fetch` (Node ≥18 /
 * Electron Main has it global). `fetch` is injected through a seam so the driver
 * logic (guard, introspection SQL, row shaping) is unit-testable with a fake.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { DEFAULT_MAX_ROWS, isReadOnlySql, normalizeCell, type DbDriver } from '../dbDriver';
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

/** The minimal `fetch` surface the driver needs (injectable for tests). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<FetchResponse>;

/** The minimal response surface the driver reads. */
export type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

/** Cloudflare D1 query API envelope (the bits we read). */
type D1Envelope = {
  success?: boolean;
  errors?: Array<{ message?: string; code?: number }>;
  result?: Array<{ results?: Array<Record<string, unknown>>; success?: boolean; meta?: { changes?: number } }>;
};

/** Quote a SQLite identifier for safe interpolation into a PRAGMA. */
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Default fetch loader: the global `fetch` (Node ≥18 / Electron Main). */
const defaultFetch: FetchLike = (url, init) => fetch(url, init) as unknown as Promise<FetchResponse>;

/** Create a Cloudflare D1 driver for a connection config (must have account/db/token). */
export const createD1Driver = (config: DbConnectionConfig, doFetch: FetchLike = defaultFetch): DbDriver => {
  const readOnly = config.readOnly !== false;
  let opened = false;

  const endpoint = (): string => {
    const accountId = config.accountId?.trim();
    const databaseId = config.databaseId?.trim();
    if (!accountId) throw new Error('A Cloudflare account id is required for D1.');
    if (!databaseId) throw new Error('A Cloudflare D1 database id is required.');
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
  };

  /** Run one SQL statement over the D1 REST API and return rows as objects. */
  const request = async (
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>>; changes: number }> => {
    const token = config.apiToken?.trim();
    if (!token) throw new Error('A Cloudflare API token is required for D1.');
    let res: FetchResponse;
    try {
      res = await doFetch(endpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sql, params: params ?? [] }),
      });
    } catch (error) {
      throw new Error(`Cloudflare D1 request failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    if (!res.ok) {
      const body = await res.text().catch((): string => '');
      throw new Error(`Cloudflare D1 returned HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    }
    const env = (await res.json().catch((): D1Envelope => ({}))) as D1Envelope;
    if (env.success === false) {
      const msg =
        env.errors
          ?.map((e) => e.message)
          .filter(Boolean)
          .join('; ') || 'Unknown D1 error';
      throw new Error(`Cloudflare D1 error: ${msg}`);
    }
    const first = env.result?.[0];
    return { rows: first?.results ?? [], changes: first?.meta?.changes ?? 0 };
  };

  const connect = async (): Promise<void> => {
    // Probe connectivity + credentials up-front (mirrors the native drivers).
    await request('SELECT 1');
    opened = true;
  };

  const ensure = (): void => {
    if (!opened) throw new Error('Cloudflare D1 connection is not open.');
  };

  const getSchema = async (): Promise<DbSchema> => {
    ensure();
    const { rows } = await request(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    const tables: DbTable[] = rows.map((r) => ({ name: String(r.name), type: r.type === 'view' ? 'view' : 'table' }));
    return { kind: 'd1', tables };
  };

  const getColumns = async (table: string): Promise<DbColumn[]> => {
    ensure();
    const { rows } = await request(`PRAGMA table_info(${quoteIdent(table)})`);
    return rows.map((r) => ({
      name: String(r.name),
      type: String(r.type || 'unknown'),
      nullable: Number(r.notnull) === 0,
      primaryKey: Number(r.pk) > 0,
    }));
  };

  const getIndexes = async (table: string): Promise<DbIndex[]> => {
    ensure();
    const { rows: list } = await request(`PRAGMA index_list(${quoteIdent(table)})`);
    const out: DbIndex[] = [];
    for (const idx of list) {
      const name = String(idx.name);
      // eslint-disable-next-line no-await-in-loop
      const { rows: cols } = await request(`PRAGMA index_info(${quoteIdent(name)})`);
      out.push({
        name,
        columns: cols.map((c) => String(c.name)),
        unique: Number(idx.unique) === 1,
        primary: idx.origin === 'pk',
      });
    }
    return out;
  };

  const getForeignKeys = async (table: string): Promise<DbForeignKey[]> => {
    ensure();
    const { rows } = await request(`PRAGMA foreign_key_list(${quoteIdent(table)})`);
    const byId = new Map<number, DbForeignKey>();
    for (const r of rows) {
      const id = Number(r.id);
      const existing = byId.get(id);
      if (existing) {
        existing.columns.push(String(r.from));
        existing.referencedColumns.push(String(r.to));
      } else {
        byId.set(id, {
          name: `fk_${table}_${id}`,
          columns: [String(r.from)],
          referencedTable: String(r.table),
          referencedColumns: [String(r.to)],
        });
      }
    }
    return [...byId.values()];
  };

  const query = async (sql: string, options?: DbQueryOptions): Promise<DbQueryResult> => {
    ensure();
    if (readOnly && !isReadOnlySql(sql)) {
      throw new Error('This connection is read-only. Only SELECT/WITH/EXPLAIN/PRAGMA statements are allowed.');
    }
    const maxRows = options?.maxRows && options.maxRows > 0 ? options.maxRows : DEFAULT_MAX_ROWS;
    const started = Date.now();
    const { rows: objects, changes } = await request(sql, options?.params);
    const durationMs = Date.now() - started;
    if (objects.length === 0) {
      // No rows: either an empty read or a write. D1 reports `changes` for writes.
      return { columns: [], rows: [], rowsAffected: changes, durationMs, truncated: false };
    }
    // Derive a stable column order from the union of keys (first-seen order).
    const columns: string[] = [];
    const seen = new Set<string>();
    for (const obj of objects) {
      for (const key of Object.keys(obj)) {
        if (!seen.has(key)) {
          seen.add(key);
          columns.push(key);
        }
      }
    }
    const limited = objects.slice(0, maxRows);
    const rows = limited.map((obj) => columns.map((c) => normalizeCell(obj[c])));
    return { columns, rows, durationMs, truncated: objects.length > maxRows };
  };

  const close = async (): Promise<void> => {
    opened = false;
  };

  return { connect, getSchema, getColumns, getIndexes, getForeignKeys, query, close };
};
