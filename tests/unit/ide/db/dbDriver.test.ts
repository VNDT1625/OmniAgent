/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the SQL safety helpers shared by every DB driver.
 */

import { describe, expect, it } from 'vitest';
import { isReadOnlySql, normalizeCell, splitStatements } from '@/process/ide/db/dbDriver';

describe('isReadOnlySql', () => {
  it('treats SELECT / WITH / EXPLAIN / SHOW / PRAGMA as read-only', () => {
    expect(isReadOnlySql('SELECT * FROM users')).toBe(true);
    expect(isReadOnlySql('  with cte as (select 1) select * from cte')).toBe(true);
    expect(isReadOnlySql('EXPLAIN SELECT 1')).toBe(true);
    expect(isReadOnlySql('SHOW TABLES')).toBe(true);
    expect(isReadOnlySql('PRAGMA table_info(users)')).toBe(true);
  });

  it('treats INSERT / UPDATE / DELETE / DROP as writes', () => {
    expect(isReadOnlySql('INSERT INTO users VALUES (1)')).toBe(false);
    expect(isReadOnlySql('UPDATE users SET x = 1')).toBe(false);
    expect(isReadOnlySql('DELETE FROM users')).toBe(false);
    expect(isReadOnlySql('DROP TABLE users')).toBe(false);
  });

  it('rejects a WITH...CTE that ends in a write', () => {
    expect(isReadOnlySql('WITH x AS (SELECT 1) DELETE FROM users')).toBe(false);
    expect(isReadOnlySql('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x')).toBe(false);
  });

  it('ignores leading comments when classifying', () => {
    expect(isReadOnlySql('-- a comment\nSELECT 1')).toBe(true);
    expect(isReadOnlySql('/* block */ DELETE FROM t')).toBe(false);
  });
});

describe('splitStatements', () => {
  it('splits on top-level semicolons', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('ignores semicolons inside string literals', () => {
    expect(splitStatements("SELECT ';'; SELECT 2")).toEqual(["SELECT ';'", 'SELECT 2']);
  });

  it('ignores semicolons inside comments', () => {
    expect(splitStatements('SELECT 1 -- ; not a split\n; SELECT 2')).toEqual(['SELECT 1 -- ; not a split', 'SELECT 2']);
  });
});

describe('normalizeCell', () => {
  it('passes through JSON-safe primitives', () => {
    expect(normalizeCell(null)).toBeNull();
    expect(normalizeCell(undefined)).toBeNull();
    expect(normalizeCell(42)).toBe(42);
    expect(normalizeCell(true)).toBe(true);
    expect(normalizeCell('hi')).toBe('hi');
  });

  it('stringifies bigint + dates + buffers', () => {
    expect(normalizeCell(10n)).toBe('10');
    expect(normalizeCell(new Date('2020-01-01T00:00:00.000Z'))).toBe('2020-01-01T00:00:00.000Z');
    expect(normalizeCell(Buffer.from([0xab, 0xcd]))).toBe('\\xabcd');
  });
});
