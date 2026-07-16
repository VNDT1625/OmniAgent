/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `dbHelpLinks` — the "where do I find this?" destinations for the connection
 * form. Each database field can point at the exact dashboard / docs page where
 * the value lives, so the user opens the right place instead of hunting for it.
 *
 * Pure constants module (renderer-safe): no Node/Electron/DOM APIs. The URLs are
 * opened through {@link openExternalUrl} by {@link FieldHelp}.
 */

import type { DbKind, DbProvider } from './dbClient';

/** Provider dashboard pages where the connection details live. */
const PROVIDER_CONNECTION_URL: Record<DbProvider, string> = {
  supabase: 'https://supabase.com/dashboard/project/_/settings/database',
  neon: 'https://console.neon.tech/',
  planetscale: 'https://app.planetscale.com/',
  rds: 'https://console.aws.amazon.com/rds/home#databases:',
};

/** Generic engine docs used when no managed provider is selected. */
const ENGINE_CONNECTION_URL: Partial<Record<DbKind, string>> = {
  postgres: 'https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING',
  mysql: 'https://dev.mysql.com/doc/refman/8.0/en/connecting.html',
};

/** Cloudflare D1 + Firebase Firestore destinations. */
export const DB_HELP_LINKS = {
  d1AccountId: 'https://dash.cloudflare.com/',
  d1DatabaseId: 'https://dash.cloudflare.com/?to=/:account/workers/d1',
  d1Token: 'https://dash.cloudflare.com/profile/api-tokens',
  firestoreProject: 'https://console.firebase.google.com/',
  firestoreToken: 'https://developers.google.com/identity/protocols/oauth2',
} as const;

/**
 * The page where a managed-provider / native-SQL user finds host, port,
 * database, user and password. Falls back to the engine's connection docs when
 * the connection is a plain self-hosted one.
 */
export const sqlConnectionHelpUrl = (kind: DbKind, provider?: DbProvider): string | undefined =>
  (provider ? PROVIDER_CONNECTION_URL[provider] : undefined) ?? ENGINE_CONNECTION_URL[kind];
