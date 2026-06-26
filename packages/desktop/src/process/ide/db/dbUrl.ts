/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `dbUrl` — parse a database connection URL / DSN into a partial
 * {@link DbConnectionConfig}. This is what makes "connect to a Docker / cloud
 * database" frictionless: a user copies the connection string Docker (or
 * Supabase / Neon / PlanetScale / RDS) hands them and pastes it once instead of
 * hand-filling host/port/db/user/password.
 *
 * Supported shapes (case-insensitive scheme):
 *   - `postgres://`, `postgresql://`        → postgres
 *   - `mysql://`, `mariadb://`              → mysql
 *   - `sqlite://<path>`, `sqlite:<path>`,
 *     `file:<path>`, or a bare `*.db` /
 *     `*.sqlite` / `*.sqlite3` path         → sqlite
 *
 * Recognised query params: `sslmode` (postgres: `require|verify-full|...` → ssl
 * on; `disable` → off), `ssl=true|1`. Everything is best-effort: an unparseable
 * input returns `null` so the caller can keep the user's hand-entered fields.
 *
 * Pure module — no Node/Electron/DOM APIs — so it is trivially unit-testable.
 */

import type { DbConnectionConfig, DbKind } from './dbTypes';
import { providerFromHost } from './dbProviders';

/** Default ports per native SQL engine, used when the URL omits one. */
const DEFAULT_PORTS: Record<'postgres' | 'mysql', number> = {
  postgres: 5432,
  mysql: 3306,
};

/** Map a URL scheme (without `://`) to an engine. */
const schemeToKind = (scheme: string): DbKind | null => {
  switch (scheme.toLowerCase()) {
    case 'postgres':
    case 'postgresql':
    case 'pg':
      return 'postgres';
    case 'mysql':
    case 'mariadb':
      return 'mysql';
    case 'sqlite':
    case 'sqlite3':
    case 'file':
      return 'sqlite';
    default:
      return null;
  }
};

/** Decode a URI component, tolerating an already-decoded value. */
const decode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Detect a bare filesystem path that looks like a SQLite database file. */
const looksLikeSqliteFile = (input: string): boolean => /\.(sqlite3?|db)$/i.test(input.trim());

/** Resolve the SSL flag from a postgres `sslmode` / generic `ssl` query param. */
const resolveSsl = (params: URLSearchParams): boolean | undefined => {
  const sslmode = params.get('sslmode');
  if (sslmode) return sslmode.toLowerCase() !== 'disable';
  const ssl = params.get('ssl');
  if (ssl) return ssl === 'true' || ssl === '1' || ssl.toLowerCase() === 'require';
  return undefined;
};

/**
 * Parse a connection URL / DSN into a partial config (everything the URL
 * carries). Returns `null` when the input is not a recognisable DB URL. The
 * caller merges the result onto an existing config (keeping id/name/readOnly).
 */
export const parseDbUrl = (raw: string): Partial<DbConnectionConfig> | null => {
  const input = raw.trim();
  if (input.length === 0) return null;

  // Windows drive path (C:/… or C:\…) — treat as a bare filesystem path, not a
  // `C:` URL scheme.
  if (/^[a-z]:[\\/]/i.test(input)) {
    return looksLikeSqliteFile(input) ? { kind: 'sqlite', file: input } : null;
  }

  // Bare path (no scheme).
  if (!/^[a-z][a-z0-9+.-]*:/i.test(input)) {
    return looksLikeSqliteFile(input) ? { kind: 'sqlite', file: input } : null;
  }

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(input);
  const scheme = schemeMatch?.[1] ?? '';
  const kind = schemeToKind(scheme);
  if (!kind) return null;

  // SQLite: scheme + path (sqlite:///abs, sqlite:////abs, sqlite://./rel, file:path).
  if (kind === 'sqlite') {
    let file = input.slice(scheme.length + 1); // strip `scheme:`
    // Collapse the authority slashes: any run of leading slashes becomes one
    // (so `////var/x` → `/var/x`, SQLAlchemy-style absolute). `file:./rel` keeps
    // its relative form (no leading slash).
    file = file.replace(/^\/{2,}/, '/');
    file = decode(file.trim());
    // `/C:/…` (a Windows path that came through with a leading slash) → `C:/…`.
    if (/^\/[a-z]:[\\/]/i.test(file)) file = file.slice(1);
    return file.length > 0 ? { kind, file } : null;
  }

  // Postgres / MySQL: parse with the URL primitive (swap scheme to http so the
  // WHATWG parser accepts arbitrary userinfo/host/port reliably).
  let url: URL;
  try {
    url = new URL(`http://${input.slice(scheme.length + 3)}`); // strip `scheme://`
  } catch {
    return null;
  }

  const database = decode(url.pathname.replace(/^\//, ''));
  const defaultPort = kind === 'mysql' ? DEFAULT_PORTS.mysql : DEFAULT_PORTS.postgres;
  const config: Partial<DbConnectionConfig> = {
    kind,
    host: url.hostname || '127.0.0.1',
    port: url.port ? Number(url.port) : defaultPort,
  };
  if (database.length > 0) config.database = database;
  if (url.username) config.user = decode(url.username);
  if (url.password) config.password = decode(url.password);
  const ssl = resolveSsl(url.searchParams);
  if (ssl !== undefined) config.ssl = ssl;
  // Recognise a managed provider from the host (Supabase / Neon / PlanetScale /
  // RDS) so the form tags it + turns SSL on by default.
  const provider = providerFromHost(config.host ?? '');
  if (provider) {
    config.provider = provider;
    if (config.ssl === undefined) config.ssl = true;
  }
  return config;
};
