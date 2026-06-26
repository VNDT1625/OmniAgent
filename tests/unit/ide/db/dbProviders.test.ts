/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the managed-provider presets (Supabase / Neon / PlanetScale /
 * RDS): the engine + SSL each preset forces, and host-based recognition.
 */

import { describe, expect, it } from 'vitest';
import { applyProviderPreset, providerFromHost } from '@/process/ide/db/dbProviders';

describe('applyProviderPreset', () => {
  it('maps supabase to postgres + ssl on (default 5432)', () => {
    const p = applyProviderPreset('supabase', {});
    expect(p.kind).toBe('postgres');
    expect(p.ssl).toBe(true);
    expect(p.port).toBe(5432);
  });

  it('keeps a non-mysql custom port for supabase', () => {
    expect(applyProviderPreset('supabase', { port: 6543 }).port).toBe(6543);
  });

  it('maps neon to postgres:5432 + ssl', () => {
    expect(applyProviderPreset('neon', {})).toEqual({ kind: 'postgres', port: 5432, ssl: true });
  });

  it('maps planetscale to mysql:3306 + ssl', () => {
    expect(applyProviderPreset('planetscale', {})).toEqual({ kind: 'mysql', port: 3306, ssl: true });
  });

  it('maps rds to postgres + ssl without forcing a port', () => {
    const p = applyProviderPreset('rds', { port: 5433 });
    expect(p.kind).toBe('postgres');
    expect(p.ssl).toBe(true);
    expect(p.port).toBeUndefined();
  });
});

describe('providerFromHost', () => {
  it('recognises Supabase pooled + direct hosts', () => {
    expect(providerFromHost('db.abcd.supabase.co')).toBe('supabase');
    expect(providerFromHost('aws-0-us-east-1.pooler.supabase.com')).toBe('supabase');
  });

  it('recognises Neon / PlanetScale / RDS hosts', () => {
    expect(providerFromHost('ep-cool-name.us-east-2.aws.neon.tech')).toBe('neon');
    expect(providerFromHost('aws.connect.psdb.cloud')).toBe('planetscale');
    expect(providerFromHost('mydb.abc123.us-east-1.rds.amazonaws.com')).toBe('rds');
  });

  it('returns undefined for an unknown host', () => {
    expect(providerFromHost('127.0.0.1')).toBeUndefined();
    expect(providerFromHost('example.com')).toBeUndefined();
  });
});
