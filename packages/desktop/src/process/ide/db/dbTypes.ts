/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
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

/** Database engines the client can talk to directly. */
export type DbKind = 'sqlite' | 'postgres' | 'mysql';

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
