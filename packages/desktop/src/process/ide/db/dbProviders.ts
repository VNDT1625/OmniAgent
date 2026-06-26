/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `dbProviders` — cosmetic presets for managed Postgres/MySQL providers
 * (Supabase, Neon, PlanetScale, Amazon RDS). These providers are NOT separate
 * engines: Supabase/Neon/RDS-postgres ARE Postgres, PlanetScale IS MySQL. So
 * the only thing a preset does is shape the connection form (default SSL on,
 * the right engine, a sensible default port) and tag the saved connection with
 * its `provider` for display. The driver layer is untouched.
 *
 * It also lets {@link parseDbUrl} *recognise* a provider from a pasted host so a
 * Supabase URL gets the Supabase badge automatically.
 *
 * Pure module — no Node/Electron/DOM APIs — usable from BOTH the renderer
 * (connection form) and the Main process (URL parser).
 */

import type { DbKind, DbProvider } from './dbTypes';

export type { DbProvider };

/** The partial connection shape a provider preset contributes. */
export type DbProviderPreset = {
  kind?: DbKind;
  host?: string;
  port?: number;
  ssl?: boolean;
};

/**
 * Apply a provider preset onto the current form values. Keeps the user's host
 * when it already looks right for the provider; always turns SSL on (managed
 * providers require TLS) and fixes the engine + default port.
 */
export const applyProviderPreset = (
  provider: DbProvider,
  current: { host?: string; port?: number; ssl?: boolean }
): DbProviderPreset => {
  switch (provider) {
    case 'supabase':
      return { kind: 'postgres', port: current.port && current.port !== 3306 ? current.port : 5432, ssl: true };
    case 'neon':
      return { kind: 'postgres', port: 5432, ssl: true };
    case 'rds':
      return { kind: 'postgres', ssl: true };
    case 'planetscale':
      return { kind: 'mysql', port: 3306, ssl: true };
    default:
      return {};
  }
};

/** Recognise a managed provider from a connection host (best-effort). */
export const providerFromHost = (host: string): DbProvider | undefined => {
  const h = host.toLowerCase();
  if (h.includes('supabase.co') || h.includes('supabase.com') || h.includes('pooler.supabase')) return 'supabase';
  if (h.includes('neon.tech')) return 'neon';
  if (h.includes('psdb.cloud') || h.includes('planetscale')) return 'planetscale';
  if (h.includes('rds.amazonaws.com')) return 'rds';
  return undefined;
};
