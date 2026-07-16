/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Firebase **Firestore** {@link DbDriver}. Firestore is a NoSQL document store,
 * not a SQL engine, so this driver is deliberately a READ-ONLY *viewer*: it maps
 * Firestore concepts onto the same surface the rest of the IDE Database feature
 * speaks so a developer can inspect their Firestore data without leaving the app
 * (the alternative is the Firebase web console):
 *
 *   - root collections          → "tables"
 *   - a document's fields       → columns (types inferred by sampling)
 *   - a collection's documents  → rows (`__id__` synthesised as the doc id)
 *
 * The "query" surface accepts a tiny `SELECT * FROM <collection> [LIMIT n]`
 * dialect (or a bare collection name) and lists that collection's documents —
 * full Firestore structured queries are out of scope. Writes are ALWAYS
 * rejected (the read-only guard cannot be turned off for this engine).
 *
 * Transport is the Firestore REST API over `fetch` (injected for tests):
 *   base: https://firestore.googleapis.com/v1/projects/{projectId}/databases/(default)/documents
 *   Authorization: Bearer {apiToken}   (a GCP OAuth access token)
 *
 * No native module, no extra dependency.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { DEFAULT_MAX_ROWS, normalizeCell, type DbDriver } from '../dbDriver';
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
import type { FetchLike, FetchResponse } from './d1Driver';

/** A Firestore typed value (the subset we decode). */
type FsValue = {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  nullValue?: null;
  timestampValue?: string;
  referenceValue?: string;
  arrayValue?: { values?: FsValue[] };
  mapValue?: { fields?: Record<string, FsValue> };
};

/** A Firestore document (the subset we decode). */
type FsDocument = { name?: string; fields?: Record<string, FsValue> };

/** Decode a Firestore typed value into a JSON-safe scalar (objects/arrays → JSON). */
const decodeValue = (value: FsValue): string | number | boolean | null => {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.timestampValue !== undefined) return value.timestampValue;
  if (value.referenceValue !== undefined) return value.referenceValue;
  if (value.nullValue !== undefined) return null;
  if (value.arrayValue) return normalizeCell((value.arrayValue.values ?? []).map(decodeValue));
  if (value.mapValue) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value.mapValue.fields ?? {})) obj[k] = decodeValue(v);
    return normalizeCell(obj);
  }
  return null;
};

/** Best-effort Firestore native type label for a value (for column introspection). */
const typeOf = (value: FsValue): string => {
  if (value.stringValue !== undefined) return 'string';
  if (value.integerValue !== undefined) return 'integer';
  if (value.doubleValue !== undefined) return 'double';
  if (value.booleanValue !== undefined) return 'boolean';
  if (value.timestampValue !== undefined) return 'timestamp';
  if (value.referenceValue !== undefined) return 'reference';
  if (value.arrayValue) return 'array';
  if (value.mapValue) return 'map';
  if (value.nullValue !== undefined) return 'null';
  return 'unknown';
};

/** The trailing path segment of a Firestore document `name` is its id. */
const docId = (name: string | undefined): string => (name ? (name.split('/').pop() ?? '') : '');

/** Parse `SELECT * FROM <collection> [LIMIT n]` (or a bare collection name). */
const parseCollectionQuery = (sql: string): { collection: string; limit?: number } => {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  const m = /from\s+([A-Za-z0-9_./-]+)(?:\s+limit\s+(\d+))?/i.exec(trimmed);
  if (m) return { collection: m[1], limit: m[2] ? Number(m[2]) : undefined };
  // A bare token is treated as a collection name.
  if (/^[A-Za-z0-9_./-]+$/.test(trimmed)) return { collection: trimmed };
  throw new Error('Firestore supports "SELECT * FROM <collection> [LIMIT n]" or a bare collection name.');
};

/** Default fetch loader: the global `fetch`. */
const defaultFetch: FetchLike = (url, init) => fetch(url, init) as unknown as Promise<FetchResponse>;

/** Create a Firebase Firestore driver for a connection config (project id + token). */
export const createFirestoreDriver = (config: DbConnectionConfig, doFetch: FetchLike = defaultFetch): DbDriver => {
  let opened = false;

  const base = (): string => {
    const projectId = config.projectId?.trim();
    if (!projectId) throw new Error('A Firebase/GCP project id is required for Firestore.');
    return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
  };

  const headers = (): Record<string, string> => {
    const token = config.apiToken?.trim();
    if (!token) throw new Error('A Firebase access token is required for Firestore.');
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  };

  const send = async (url: string, method: string, body: string): Promise<unknown> => {
    let res: FetchResponse;
    try {
      res = await doFetch(url, { method, headers: headers(), body });
    } catch (error) {
      throw new Error(`Firestore request failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    if (!res.ok) {
      const text = await res.text().catch((): string => '');
      throw new Error(`Firestore returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    return res.json().catch((): unknown => ({}));
  };

  /** List the root collection ids of the database. */
  const listCollectionIds = async (): Promise<string[]> => {
    const env = (await send(`${base()}:listCollectionIds`, 'POST', '{}')) as { collectionIds?: string[] };
    return env.collectionIds ?? [];
  };

  /** List documents of a collection (capped). */
  const listDocuments = async (collection: string, limit: number): Promise<FsDocument[]> => {
    const url = `${base()}/${collection.split('/').map(encodeURIComponent).join('/')}?pageSize=${Math.max(1, limit)}`;
    const env = (await send(url, 'GET', '')) as { documents?: FsDocument[] };
    return env.documents ?? [];
  };

  const connect = async (): Promise<void> => {
    await listCollectionIds();
    opened = true;
  };

  const ensure = (): void => {
    if (!opened) throw new Error('Firestore connection is not open.');
  };

  const getSchema = async (): Promise<DbSchema> => {
    ensure();
    const ids = await listCollectionIds();
    const tables: DbTable[] = ids.toSorted((a, b) => a.localeCompare(b)).map((name) => ({ name, type: 'table' }));
    return { kind: 'firestore', tables };
  };

  const getColumns = async (table: string): Promise<DbColumn[]> => {
    ensure();
    // Infer columns by sampling documents (Firestore is schemaless).
    const docs = await listDocuments(table, 50);
    const seen = new Map<string, string>();
    for (const doc of docs) {
      for (const [key, value] of Object.entries(doc.fields ?? {})) {
        if (!seen.has(key)) seen.set(key, typeOf(value));
      }
    }
    const columns: DbColumn[] = [{ name: '__id__', type: 'docId', nullable: false, primaryKey: true }];
    for (const [name, type] of seen) columns.push({ name, type, nullable: true, primaryKey: false });
    return columns;
  };

  // Firestore has no SQL indexes/foreign keys exposed over this surface.
  const getIndexes = async (): Promise<DbIndex[]> => {
    ensure();
    return [];
  };
  const getForeignKeys = async (): Promise<DbForeignKey[]> => {
    ensure();
    return [];
  };

  const query = async (sql: string, options?: DbQueryOptions): Promise<DbQueryResult> => {
    ensure();
    // Read-only is enforced unconditionally: a write-shaped statement is rejected.
    const { collection, limit } = parseCollectionQuery(sql);
    const maxRows = options?.maxRows && options.maxRows > 0 ? options.maxRows : DEFAULT_MAX_ROWS;
    const cap = Math.min(limit ?? maxRows, maxRows);
    const started = Date.now();
    const docs = await listDocuments(collection, cap + 1);
    const durationMs = Date.now() - started;
    // Stable column order: id first, then union of field keys (first-seen).
    const columns: string[] = ['__id__'];
    const seen = new Set<string>(['__id__']);
    for (const doc of docs) {
      for (const key of Object.keys(doc.fields ?? {})) {
        if (!seen.has(key)) {
          seen.add(key);
          columns.push(key);
        }
      }
    }
    const limited = docs.slice(0, cap);
    const rows = limited.map((doc) =>
      columns.map((col) =>
        col === '__id__' ? docId(doc.name) : doc.fields?.[col] ? decodeValue(doc.fields[col]) : null
      )
    );
    return { columns, rows, durationMs, truncated: docs.length > cap };
  };

  const close = async (): Promise<void> => {
    opened = false;
  };

  return { connect, getSchema, getColumns, getIndexes, getForeignKeys, query, close };
};
