/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LSP response converters — PURE helpers that turn the raw, loosely-typed LSP
 * payloads (WorkspaceEdit, TextEdit[], DocumentSymbol[]) into the editor-facing
 * shapes the runtime exposes. Kept separate from {@link file://./lspRuntime.ts}
 * so the fiddly 0-based→1-based + nested-shape handling is unit-testable without
 * spawning a server.
 *
 * LSP positions are 0-based (line + character); the editor + our bridge use
 * 1-based line/column. Every converter here does that shift and is defensive:
 * a missing/odd field yields a safe default rather than throwing, so a slightly
 * non-conformant server never crashes a feature.
 *
 * Process boundary: Main-process module, but pure (no Node APIs used here).
 */

/** A single text edit (1-based range) — mirrors lspRuntime's LspTextEdit. */
export type LspTextEdit = {
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  newText: string;
};

/** A document symbol for the outline view (mirrors lspRuntime's LspSymbol). */
export type LspSymbol = {
  name: string;
  kind: number;
  line: number;
  column: number;
  detail?: string;
  children?: LspSymbol[];
};

/** Convert a `file://` URI to a filesystem path (Windows drive-letter safe). */
export const fromUri = (uri: string): string => {
  try {
    return decodeURIComponent(new URL(uri).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
  } catch {
    return uri;
  }
};

/** A 0-based LSP position → 1-based line/column. */
const oneBased = (pos: unknown): { line: number; column: number } => {
  const p = (pos ?? {}) as { line?: number; character?: number };
  return { line: (p.line ?? 0) + 1, column: (p.character ?? 0) + 1 };
};

/** One raw `{ range, newText }` TextEdit → our 1-based {@link LspTextEdit}. */
const oneEdit = (path: string, raw: unknown): LspTextEdit => {
  const edit = (raw ?? {}) as { range?: { start?: unknown; end?: unknown }; newText?: unknown };
  const start = oneBased(edit.range?.start);
  const end = oneBased(edit.range?.end);
  return {
    path,
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
    newText: typeof edit.newText === 'string' ? edit.newText : '',
  };
};

/** Parse a raw `TextEdit[]` for ONE file (formatting result). */
export const parseTextEditArray = (filePath: string, raw: unknown): LspTextEdit[] => {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => oneEdit(filePath, item));
};

/**
 * Parse a `WorkspaceEdit` (rename result) into a flat edit list across files.
 * Handles both shapes the spec allows:
 *  - `changes`: `{ [uri]: TextEdit[] }`
 *  - `documentChanges`: `[{ textDocument: { uri }, edits: TextEdit[] }]`
 */
export const parseWorkspaceEdit = (raw: unknown): LspTextEdit[] => {
  const we = (raw ?? {}) as {
    changes?: Record<string, unknown[]>;
    documentChanges?: unknown[];
  };
  const out: LspTextEdit[] = [];

  if (we.changes && typeof we.changes === 'object') {
    for (const [uri, edits] of Object.entries(we.changes)) {
      const path = fromUri(uri);
      if (Array.isArray(edits)) for (const edit of edits) out.push(oneEdit(path, edit));
    }
  }

  if (Array.isArray(we.documentChanges)) {
    for (const change of we.documentChanges) {
      const c = (change ?? {}) as { textDocument?: { uri?: string }; edits?: unknown[] };
      // Skip non-edit operations (create/rename/delete file) — we only apply text.
      if (!c.textDocument?.uri || !Array.isArray(c.edits)) continue;
      const path = fromUri(c.textDocument.uri);
      for (const edit of c.edits) out.push(oneEdit(path, edit));
    }
  }

  return out;
};

/**
 * Parse `DocumentSymbol[]` (hierarchical) OR `SymbolInformation[]` (flat) into
 * our nested {@link LspSymbol} tree. DocumentSymbol nests via `children` and
 * locates via `selectionRange`/`range`; SymbolInformation is flat and locates
 * via `location.range`.
 */
export const parseDocumentSymbols = (raw: unknown[]): LspSymbol[] =>
  raw.map((item) => {
    const s = item as {
      name?: unknown;
      kind?: unknown;
      detail?: unknown;
      range?: { start?: unknown };
      selectionRange?: { start?: unknown };
      location?: { range?: { start?: unknown } };
      children?: unknown[];
    };
    const start = oneBased(s.selectionRange?.start ?? s.range?.start ?? s.location?.range?.start);
    const symbol: LspSymbol = {
      name: typeof s.name === 'string' ? s.name : '',
      kind: typeof s.kind === 'number' ? s.kind : 0,
      line: start.line,
      column: start.column,
      detail: typeof s.detail === 'string' ? s.detail : undefined,
    };
    if (Array.isArray(s.children) && s.children.length > 0) {
      symbol.children = parseDocumentSymbols(s.children);
    }
    return symbol;
  });
