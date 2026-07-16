/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the IDE **Database** surface — a multi-connection database
 * client built into the IDE so the user (and an agent) can inspect and query
 * the database(s) of the open repo without leaving the app or installing a
 * separate tool (DBeaver / TablePlus / psql).
 *
 * Kept in one module so the driver layer, connection store, service, bridge and
 * the agent-facing MCP server reuse the same shapes without circular imports.
 *
 * Process boundary: Main-process (Node.js) types only — no DOM, no runtime.
 */

/**
 * Database engines the client can talk to directly.
 *
 * `sqlite` / `postgres` / `mysql` are native (driver wraps `better-sqlite3` /
 * `pg` / `mysql2`). `d1` (Cloudflare D1) and `firestore` (Firebase Firestore)
 * are **cloud HTTP** engines whose drivers talk to a REST API via `fetch` (no
 * native module, no extra dependency). Supabase / Neon / PlanetScale are NOT
 * separate kinds — they are reached through `postgres` / `mysql` (they ARE those
 * engines); a UI preset just pre-fills their connection shape.
 */
export type DbKind = 'sqlite' | 'postgres' | 'mysql' | 'd1' | 'firestore';

/** Engines whose driver speaks SQL (read-only guard + introspection apply). */
export const SQL_KINDS: ReadonlySet<DbKind> = new Set<DbKind>(['sqlite', 'postgres', 'mysql', 'd1']);

/** Engines reached over a cloud HTTP REST API (no native module). */
export const CLOUD_HTTP_KINDS: ReadonlySet<DbKind> = new Set<DbKind>(['d1', 'firestore']);

/**
 * A known managed-Postgres/MySQL provider. Cosmetic: it only drives the
 * connection-form preset (host shape, SSL default) — the underlying engine is
 * still `postgres` / `mysql`, so no driver change is needed.
 */
export type DbProvider = 'supabase' | 'neon' | 'planetscale' | 'rds';

/**
 * A saved connection definition. Secrets (passwords) are NEVER stored in this
 * object on disk in plaintext — they are encrypted at rest with Electron
 * `safeStorage`, keyed by {@link id}. The in-memory copy may carry a transient
 * `password` while connecting.
 */
export type DbConnectionConfig = {
  /** Stable unique id (used as the keychain account + map key). */
  id: string;
  /** Human-readable label shown in the UI. */
  name: string;
  /** Engine. */
  kind: DbKind;
  /** Absolute file path (sqlite only). */
  file?: string;
  /** Host (postgres/mysql). */
  host?: string;
  /** Port (postgres/mysql). */
  port?: number;
  /** Database / schema name (postgres/mysql). */
  database?: string;
  /** User (postgres/mysql). */
  user?: string;
  /** Transient password (never persisted in the JSON store; kept in keychain). */
  password?: string;
  /** Use TLS/SSL (postgres/mysql). */
  ssl?: boolean;
  /**
   * Read-only guard. When true, the service rejects any statement that is not a
   * read (SELECT / WITH / EXPLAIN / SHOW / PRAGMA). Defaults to true for safety.
   */
  readOnly?: boolean;
  /** Repo root this connection belongs to (so the IDE can scope the list). */
  rootPath?: string;
  /**
   * Managed provider this connection targets (cosmetic; postgres/mysql only).
   * Drives the connection-form preset, NOT the driver choice.
   */
  provider?: DbProvider;

  // --- Cloudflare D1 (kind: 'd1') -----------------------------------------
  /** Cloudflare account id (D1). */
  accountId?: string;
  /** Cloudflare D1 database id. */
  databaseId?: string;
  /**
   * Cloudflare API token with D1 access (D1) / Firebase access token or web API
   * key (firestore). Treated as a SECRET — encrypted at rest like `password`,
   * never sent to the renderer in plaintext.
   */
  apiToken?: string;

  // --- Firebase Firestore (kind: 'firestore') -----------------------------
  /** Firebase / GCP project id (firestore). */
  projectId?: string;
};

/** A column of a table, from schema introspection. */
export type DbColumn = {
  name: string;
  /** Engine-native type string (e.g. `varchar(255)`, `integer`). */
  type: string;
  /** Whether the column accepts NULL. */
  nullable: boolean;
  /** Whether the column is part of the primary key. */
  primaryKey: boolean;
};

/** A table (or view) in the connected database. */
export type DbTable = {
  /** Schema/owner (postgres). Empty for sqlite/mysql single-schema. */
  schema?: string;
  /** Table name. */
  name: string;
  /** 'table' or 'view'. */
  type: 'table' | 'view';
  /** Approximate row count when cheaply available (else undefined). */
  rowCount?: number;
};

/** An index on a table, from schema introspection. */
export type DbIndex = {
  /** Index name. */
  name: string;
  /** Columns covered by the index, in order. */
  columns: string[];
  /** Whether the index enforces uniqueness. */
  unique: boolean;
  /** Whether this is the primary-key index (when the engine reports it). */
  primary?: boolean;
};

/** A foreign-key constraint on a table, from schema introspection. */
export type DbForeignKey = {
  /** Constraint name (engine-generated when unnamed). */
  name: string;
  /** Local column(s) that reference the parent table. */
  columns: string[];
  /** Referenced table (optionally schema-qualified for postgres). */
  referencedTable: string;
  /** Referenced schema/owner (postgres). */
  referencedSchema?: string;
  /** Referenced column(s), aligned to {@link columns}. */
  referencedColumns: string[];
};

/** The full detail of one table: columns + indexes + foreign keys. */
export type DbTableDetail = {
  columns: DbColumn[];
  indexes: DbIndex[];
  foreignKeys: DbForeignKey[];
};

/** One table node in the schema (ER) graph: identity + columns + outgoing FKs. */
export type DbSchemaGraphTable = {
  schema?: string;
  name: string;
  type: 'table' | 'view';
  columns: DbColumn[];
  foreignKeys: DbForeignKey[];
};

/** A compact whole-schema graph for ER-diagram visualization. */
export type DbSchemaGraph = {
  kind: DbKind;
  tables: DbSchemaGraphTable[];
  /** True when the schema was capped at the table limit (graph is partial). */
  truncated: boolean;
};

/** The full schema snapshot of a connection. */
export type DbSchema = {
  /** Engine. */
  kind: DbKind;
  /** Tables + views, ordered by schema then name. */
  tables: DbTable[];
};

/** The result of running a single SQL statement. */
export type DbQueryResult = {
  /** Column names, in order, for a row-returning statement. */
  columns: string[];
  /** Rows as arrays aligned to {@link columns}. */
  rows: Array<Array<string | number | boolean | null>>;
  /** Number of rows affected for a write (when the engine reports it). */
  rowsAffected?: number;
  /** Wall-clock duration of the statement in ms. */
  durationMs: number;
  /** Whether the result set was capped at the row limit. */
  truncated: boolean;
};

/** One statement's result within a multi-statement script run. */
export type DbScriptStatementResult = DbQueryResult & {
  /** The (trimmed) SQL text of this statement. */
  sql: string;
  /** Set when this statement threw; the script stops at the first error. */
  error?: string;
};

/** The result of running a multi-statement SQL script. */
export type DbScriptResult = {
  /** Per-statement results, in execution order. */
  statements: DbScriptStatementResult[];
  /** Total wall-clock duration of the whole script in ms. */
  durationMs: number;
  /** Whether the script stopped early because a statement errored. */
  aborted: boolean;
};

/** Options for {@link DbDriver.query}. */
export type DbQueryOptions = {
  /** Bound parameters (positional). */
  params?: Array<string | number | boolean | null>;
  /** Hard cap on returned rows (the driver enforces it). */
  maxRows?: number;
  /** Statement timeout in ms. */
  timeoutMs?: number;
};

/** Always-resolving result envelope (mirrors the other IDE bridges). */
export type DbResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Live connection state surfaced to the UI. */
export type DbConnectionState = {
  config: Omit<DbConnectionConfig, 'password'>;
  /** Whether a live connection/pool is currently open. */
  connected: boolean;
  /** Last error message (connect or query), if any. */
  lastError?: string;
};

/**
 * A statistical profile of ONE column, computed by the data-analysis layer
 * ({@link DbService.profileColumn}) with a single aggregate SQL query. This is
 * what powers the "understand this table at a glance" panel for developers:
 * how full is the column, how many distinct values, and (for numbers) the
 * spread. Everything here is cheap to compute and JSON-safe.
 */
export type DbColumnProfile = {
  /** Column name. */
  column: string;
  /** Engine-native type string (echoed from introspection). */
  type: string;
  /** Total rows considered (capped — see {@link DbColumnProfile.sampled}). */
  total: number;
  /** Count of NULL values in the sample. */
  nulls: number;
  /** Count of DISTINCT non-null values in the sample. */
  distinct: number;
  /** Min value (numeric columns; null when not applicable). */
  min?: number | null;
  /** Max value (numeric columns; null when not applicable). */
  max?: number | null;
  /** Mean of the values (numeric columns; null when not applicable). */
  avg?: number | null;
  /** Whether the profile was computed over a capped sample (very large table). */
  sampled: boolean;
  /**
   * Top frequent values (value + count), for low-cardinality columns. Empty
   * when the column is effectively unique (distinct ≈ total) or not profiled.
   */
  topValues: Array<{ value: string | number | boolean | null; count: number }>;
};

/** A whole-table profile: row count + a profile per column. */
export type DbTableProfile = {
  /** Schema/owner (postgres). */
  schema?: string;
  /** Table name. */
  table: string;
  /** Approximate/exact total row count of the table. */
  rowCount: number;
  /** Whether profiling sampled (capped) the table instead of scanning it all. */
  sampled: boolean;
  /** Per-column statistical profiles. */
  columns: DbColumnProfile[];
};
