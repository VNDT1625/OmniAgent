/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the CSV / JSON result exporters.
 */

import { describe, expect, it } from 'vitest';
import { toCsv, toJson } from '@/process/ide/db/dbExport';
import type { DbQueryResult } from '@/process/ide/db/dbTypes';

const result = (over: Partial<DbQueryResult> = {}): DbQueryResult => ({
  columns: ['id', 'name'],
  rows: [
    [1, 'Ada'],
    [2, 'Linus'],
  ],
  durationMs: 1,
  truncated: false,
  ...over,
});

describe('toCsv', () => {
  it('renders a header + data rows with CRLF', () => {
    expect(toCsv(result())).toBe('id,name\r\n1,Ada\r\n2,Linus');
  });

  it('quotes cells with commas, quotes, or newlines and renders NULL as empty', () => {
    const csv = toCsv(
      result({
        rows: [
          [1, 'a,b'],
          [2, 'say "hi"'],
          [3, null],
        ],
      })
    );
    expect(csv).toBe('id,name\r\n1,"a,b"\r\n2,"say ""hi"""\r\n3,');
  });

  it('returns just the header when there are no rows', () => {
    expect(toCsv(result({ rows: [] }))).toBe('id,name');
  });
});

describe('toJson', () => {
  it('renders an array of row objects', () => {
    expect(JSON.parse(toJson(result()))).toEqual([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Linus' },
    ]);
  });

  it('disambiguates duplicate column names', () => {
    const parsed = JSON.parse(toJson(result({ columns: ['id', 'id'], rows: [[1, 2]] })));
    expect(parsed).toEqual([{ id: 1, id__2: 2 }]);
  });
});
