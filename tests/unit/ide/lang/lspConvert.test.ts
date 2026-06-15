/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  fromUri,
  parseDocumentSymbols,
  parseTextEditArray,
  parseWorkspaceEdit,
} from '../../../../packages/desktop/src/process/ide/lang/lspConvert';

describe('fromUri', () => {
  it('decodes a posix file uri', () => {
    expect(fromUri('file:///home/user/a%20b.ts')).toBe('/home/user/a b.ts');
  });

  it('keeps a windows drive path readable', () => {
    expect(fromUri('file:///c:/proj/x.ts')).toBe('c:/proj/x.ts');
  });

  it('returns the input unchanged when not a uri', () => {
    expect(fromUri('not a uri')).toBe('not a uri');
  });
});

describe('parseTextEditArray', () => {
  it('maps 0-based ranges to 1-based edits for one file', () => {
    const raw = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: 'cost' }];
    const edits = parseTextEditArray('/x.ts', raw);
    expect(edits).toEqual([
      { path: '/x.ts', startLine: 1, startColumn: 1, endLine: 1, endColumn: 5, newText: 'cost' },
    ]);
  });

  it('returns empty for non-array input', () => {
    expect(parseTextEditArray('/x.ts', null)).toEqual([]);
    expect(parseTextEditArray('/x.ts', { nope: true })).toEqual([]);
  });

  it('defaults a missing newText to empty string', () => {
    const edits = parseTextEditArray('/x.ts', [{ range: { start: {}, end: {} } }]);
    expect(edits[0].newText).toBe('');
    expect(edits[0].startLine).toBe(1);
  });
});

describe('parseWorkspaceEdit', () => {
  it('flattens the `changes` map across files', () => {
    const we = {
      changes: {
        'file:///a.ts': [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, newText: 'foo' }],
        'file:///b.ts': [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' }],
      },
    };
    const edits = parseWorkspaceEdit(we);
    expect(edits).toHaveLength(2);
    expect(edits.find((e) => e.path === '/a.ts')).toMatchObject({ startLine: 2, startColumn: 3, newText: 'foo' });
    expect(edits.find((e) => e.path === '/b.ts')).toMatchObject({ startLine: 1, startColumn: 1, newText: 'x' });
  });

  it('flattens `documentChanges` and skips file operations', () => {
    const we = {
      documentChanges: [
        {
          textDocument: { uri: 'file:///a.ts' },
          edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'new' }],
        },
        // A rename-file operation (no textDocument.edits) must be ignored.
        { kind: 'rename', oldUri: 'file:///a.ts', newUri: 'file:///c.ts' },
      ],
    };
    const edits = parseWorkspaceEdit(we);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ path: '/a.ts', newText: 'new' });
  });

  it('returns empty for an empty / odd workspace edit', () => {
    expect(parseWorkspaceEdit(null)).toEqual([]);
    expect(parseWorkspaceEdit({})).toEqual([]);
  });
});

describe('parseDocumentSymbols', () => {
  it('parses hierarchical DocumentSymbols with children', () => {
    const raw = [
      {
        name: 'MyClass',
        kind: 5,
        range: { start: { line: 10, character: 0 } },
        selectionRange: { start: { line: 10, character: 6 } },
        children: [{ name: 'method', kind: 6, selectionRange: { start: { line: 11, character: 2 } } }],
      },
    ];
    const symbols = parseDocumentSymbols(raw);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'MyClass', kind: 5, line: 11, column: 7 });
    expect(symbols[0].children).toHaveLength(1);
    expect(symbols[0].children?.[0]).toMatchObject({ name: 'method', line: 12, column: 3 });
  });

  it('parses flat SymbolInformation via location.range', () => {
    const raw = [{ name: 'fn', kind: 12, location: { range: { start: { line: 4, character: 0 } } } }];
    const symbols = parseDocumentSymbols(raw);
    expect(symbols[0]).toMatchObject({ name: 'fn', kind: 12, line: 5, column: 1 });
    expect(symbols[0].children).toBeUndefined();
  });

  it('defaults missing name/kind safely', () => {
    const symbols = parseDocumentSymbols([{}]);
    expect(symbols[0]).toMatchObject({ name: '', kind: 0, line: 1, column: 1 });
  });
});
