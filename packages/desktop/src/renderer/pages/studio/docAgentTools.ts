/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `docAgentTools` — the tool catalogue + dispatcher used to edit the *live*
 * ONLYOFFICE document via {@link onlyOfficeConnector}.
 *
 * The Office-editor MCP server (Main process) sends ONE action at a time over
 * the editor-tools bridge; the renderer provider
 * ({@link file://./editorToolsProvider.ts}) validates it with {@link parseAction}
 * and runs it with {@link runTool} against the live editor, returning a short
 * observation. Each tool runs locally inside the editor, so it completes in well
 * under a second.
 *
 * Renderer-only.
 */

import {
  appendText,
  applyHeadings,
  formatPassage,
  formatText,
  insertTable,
  insertTableOfContents,
  insertText,
  readText,
  replaceAllText,
  replacePassage,
  runOfficeScript,
  searchReplace,
  setCells,
  type OfficeDocKind,
  type TextFormat,
} from '@renderer/pages/editor/adapters/onlyOfficeConnector';

/** A single action the model may request. */
export type DocAgentAction =
  | { tool: 'read_document' }
  | { tool: 'replace_all'; text: string }
  | { tool: 'search_replace'; search: string; replace: string }
  | { tool: 'replace_passage'; find: string; replacement: string; until?: string }
  | { tool: 'insert_text'; text: string }
  | { tool: 'append_text'; text: string }
  | { tool: 'apply_headings'; headings: Array<{ text: string; level: number }> }
  | { tool: 'insert_toc'; atStart?: boolean }
  | { tool: 'format_text'; search: string; format: TextFormat }
  | { tool: 'format_passage'; find: string; format: TextFormat; until?: string }
  | { tool: 'insert_table'; rows: number; cols: number; data?: string[][] }
  | { tool: 'set_cells'; start: string; values: Array<Array<string | number>>; sheet?: string }
  | { tool: 'run_office_api'; code: string }
  | { tool: 'finish'; summary: string };

/** Result of executing one action. `done` ends the loop. */
export type ToolResult = { observation: string; done: boolean };

/** Human-readable tool list embedded in the system prompt (kept in sync with the union). */
export const TOOL_GUIDE = [
  'read_document — read the current document text. Args: none. Returns the text.',
  'replace_all — replace the WHOLE document with new text (Word only). Args: { "text": string }.',
  'search_replace — replace every occurrence of a string. Args: { "search": string, "replace": string }.',
  'replace_passage — replace ONE specific passage (Word only), the reliable way to edit a particular paragraph. Args: { "find": string, "replacement": string, "until"?: string }. With "find" alone it replaces the FIRST occurrence. With "find"+"until" it replaces everything from the start of "find" through the end of the first following "until" — pass the first few words as "find" and the last few words as "until" to target a long paragraph without quoting it all.',
  'insert_text — paste text at the cursor (replacing any selection). Args: { "text": string }.',
  'append_text — add a paragraph at the end (Word only). Args: { "text": string }.',
  'apply_headings — apply real heading styles (Heading 1–9) to paragraphs by exact text (Word only). Args: { "headings": [{ "text": string, "level": number }] }. Use this to mark section titles so a table of contents can pick them up.',
  'insert_toc — insert a real, auto-updating Table of Contents from the heading-styled paragraphs (Word only). Args: { "atStart": boolean }. Apply headings FIRST.',
  'format_text — apply character formatting to EVERY occurrence of a string (Word only). Args: { "search": string, "format": { "bold"?: boolean, "italic"?: boolean, "underline"?: boolean, "strikeout"?: boolean, "color"?: "#RRGGBB", "highlight"?: "#RRGGBB", "fontSize"?: number, "fontFamily"?: string } }.',
  'format_passage — format ONE specific passage (Word only) — like selecting the whole paragraph then applying bold/italic/etc. Args: { "find": string, "format": {…same as format_text…}, "until"?: string }. "find" alone targets the first occurrence; "find"+"until" covers everything from the start of "find" through the end of the first following "until" (pass first words as "find", last words as "until" for a long paragraph).',
  'insert_table — insert a table at the end (Word only). Args: { "rows": number, "cols": number, "data"?: string[][] }. When "data" is given it fills the cells and sets the size.',
  'set_cells — write a block of spreadsheet cells (Excel only). Args: { "start": "A1", "values": (string|number)[][], "sheet"?: string }. Values are written row-by-row from "start".',
  'run_office_api — run ANY ONLYOFFICE Document Builder API script in the live editor — the "do anything Office can do" tool. Args: { "code": string } where code is a JS body that uses the global `Api` and may `return` a JSON-serializable value. Word: `Api.GetDocument()` (paragraphs, runs, tables, images, charts, styles, sections, comments, bookmarks, page setup). Spreadsheet: `Api.GetActiveSheet()` / `Api.GetSheet(i)` (ranges, cells, formulas, charts, formats). Presentation: `Api.GetPresentation()` (slides, shapes, text). Example (Word, insert a 2x2 table): "const d=Api.GetDocument(); const t=Api.CreateTable(2,2); d.Push(t); return \'ok\';". Sandboxed to the document — no file/network/Node access. Prefer the specific tools above for common edits; use this for everything else (images, charts, page setup, find by style, etc.).',
  'finish — stop and report what you did. Args: { "summary": string }.',
].join('\n');

/** Tools available per document kind (others are rejected with guidance). */
const ALLOWED: Record<OfficeDocKind, ReadonlySet<string>> = {
  word: new Set([
    'read_document',
    'replace_all',
    'search_replace',
    'replace_passage',
    'insert_text',
    'append_text',
    'apply_headings',
    'insert_toc',
    'format_text',
    'format_passage',
    'insert_table',
    'run_office_api',
    'finish',
  ]),
  cell: new Set(['read_document', 'search_replace', 'insert_text', 'set_cells', 'run_office_api', 'finish']),
  slide: new Set(['read_document', 'search_replace', 'insert_text', 'run_office_api', 'finish']),
};

/** Parse a {@link TextFormat} object from untrusted input (or null if invalid). */
const parseTextFormat = (value: unknown): TextFormat | null => {
  if (typeof value !== 'object' || value === null) return null;
  const f = value as Record<string, unknown>;
  const fmt: TextFormat = {};
  if (typeof f.bold === 'boolean') fmt.bold = f.bold;
  if (typeof f.italic === 'boolean') fmt.italic = f.italic;
  if (typeof f.underline === 'boolean') fmt.underline = f.underline;
  if (typeof f.strikeout === 'boolean') fmt.strikeout = f.strikeout;
  if (typeof f.color === 'string') fmt.color = f.color;
  if (typeof f.highlight === 'string') fmt.highlight = f.highlight;
  if (typeof f.fontSize === 'number') fmt.fontSize = f.fontSize;
  if (typeof f.fontFamily === 'string') fmt.fontFamily = f.fontFamily;
  return fmt;
};

/** Validate that `value` is a well-formed {@link DocAgentAction}. */
export const parseAction = (value: unknown): DocAgentAction | null => {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const tool = v.tool;
  switch (tool) {
    case 'read_document':
      return { tool };
    case 'replace_all':
      return typeof v.text === 'string' ? { tool, text: v.text } : null;
    case 'search_replace':
      return typeof v.search === 'string' && typeof v.replace === 'string'
        ? { tool, search: v.search, replace: v.replace }
        : null;
    case 'replace_passage':
      return typeof v.find === 'string' && v.find.length > 0 && typeof v.replacement === 'string'
        ? { tool, find: v.find, replacement: v.replacement, until: typeof v.until === 'string' ? v.until : undefined }
        : null;
    case 'insert_text':
      return typeof v.text === 'string' ? { tool, text: v.text } : null;
    case 'append_text':
      return typeof v.text === 'string' ? { tool, text: v.text } : null;
    case 'apply_headings': {
      if (!Array.isArray(v.headings)) return null;
      const headings: Array<{ text: string; level: number }> = [];
      for (const raw of v.headings) {
        if (typeof raw !== 'object' || raw === null) return null;
        const h = raw as Record<string, unknown>;
        const text = h.text;
        const level = h.level;
        if (typeof text !== 'string' || typeof level !== 'number') return null;
        // Clamp to valid Word heading levels.
        const lvl = Math.min(9, Math.max(1, Math.round(level)));
        headings.push({ text, level: lvl });
      }
      return headings.length > 0 ? { tool, headings } : null;
    }
    case 'insert_toc':
      return { tool, atStart: typeof v.atStart === 'boolean' ? v.atStart : true };
    case 'format_text': {
      if (typeof v.search !== 'string' || v.search.length === 0) return null;
      const fmt = parseTextFormat(v.format);
      return fmt ? { tool, search: v.search, format: fmt } : null;
    }
    case 'format_passage': {
      if (typeof v.find !== 'string' || v.find.length === 0) return null;
      const fmt = parseTextFormat(v.format);
      return fmt ? { tool, find: v.find, format: fmt, until: typeof v.until === 'string' ? v.until : undefined } : null;
    }
    case 'insert_table': {
      const rows = typeof v.rows === 'number' ? Math.round(v.rows) : 0;
      const cols = typeof v.cols === 'number' ? Math.round(v.cols) : 0;
      let data: string[][] | undefined;
      if (Array.isArray(v.data)) {
        const grid: string[][] = [];
        for (const row of v.data) {
          if (!Array.isArray(row)) return null;
          grid.push(row.map((c) => String(c)));
        }
        data = grid;
      }
      if ((rows < 1 || cols < 1) && !data) return null;
      return { tool, rows: Math.max(1, rows), cols: Math.max(1, cols), data };
    }
    case 'set_cells': {
      if (typeof v.start !== 'string' || v.start.length === 0) return null;
      if (!Array.isArray(v.values)) return null;
      const values: Array<Array<string | number>> = [];
      for (const row of v.values) {
        if (!Array.isArray(row)) return null;
        values.push(row.map((c) => (typeof c === 'number' ? c : String(c))));
      }
      if (values.length === 0) return null;
      return { tool, start: v.start, values, sheet: typeof v.sheet === 'string' ? v.sheet : undefined };
    }
    case 'run_office_api':
      return typeof v.code === 'string' && v.code.trim().length > 0 ? { tool, code: v.code } : null;
    case 'finish':
      return { tool, summary: typeof v.summary === 'string' ? v.summary : '' };
    default:
      return null;
  }
};

/** How much document text to feed back per read (avoid oversized prompts). */
const MAX_READ_CHARS = 12000;

/**
 * Execute one validated action against the live editor for `filePath`.
 * Returns a short observation and whether the loop should stop.
 */
export const runTool = async (filePath: string, kind: OfficeDocKind, action: DocAgentAction): Promise<ToolResult> => {
  if (action.tool === 'finish') {
    return { observation: action.summary || 'Done.', done: true };
  }
  if (!ALLOWED[kind].has(action.tool)) {
    return {
      observation: `Tool "${action.tool}" is not available for this ${kind} document. Allowed: ${[...ALLOWED[kind]].join(', ')}.`,
      done: false,
    };
  }
  try {
    switch (action.tool) {
      case 'read_document': {
        const text = await readText(filePath);
        const clipped = text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n…(truncated)` : text;
        return { observation: `Document text:\n${clipped}`, done: false };
      }
      case 'replace_all':
        await replaceAllText(filePath, action.text);
        return { observation: 'Replaced the whole document.', done: false };
      case 'search_replace':
        await searchReplace(filePath, action.search, action.replace);
        return { observation: `Replaced "${action.search}" with "${action.replace}".`, done: false };
      case 'replace_passage': {
        const ok = await replacePassage(filePath, action.find, action.replacement, action.until);
        return {
          observation: ok
            ? `Replaced the passage starting "${action.find.slice(0, 40)}".`
            : `Could not locate the passage starting "${action.find.slice(0, 40)}". Read the document and use the exact text.`,
          done: false,
        };
      }
      case 'insert_text':
        await insertText(filePath, action.text);
        return { observation: 'Inserted text at the cursor.', done: false };
      case 'append_text':
        await appendText(filePath, action.text);
        return { observation: 'Appended a paragraph at the end.', done: false };
      case 'apply_headings': {
        const applied = await applyHeadings(filePath, action.headings);
        return {
          observation:
            applied > 0
              ? `Applied heading styles to ${applied} of ${action.headings.length} paragraph(s).`
              : 'No paragraphs matched the given heading texts (check they match the document text exactly).',
          done: false,
        };
      }
      case 'insert_toc':
        await insertTableOfContents(filePath, action.atStart ?? true);
        return { observation: 'Inserted an automatic table of contents.', done: false };
      case 'format_text': {
        const n = await formatText(filePath, action.search, action.format);
        return {
          observation:
            n > 0
              ? `Formatted ${n} occurrence(s) of "${action.search}".`
              : `No occurrences of "${action.search}" were found to format.`,
          done: false,
        };
      }
      case 'format_passage': {
        const ok = await formatPassage(filePath, action.find, action.format, action.until);
        return {
          observation: ok
            ? `Formatted the passage starting "${action.find.slice(0, 40)}".`
            : `Could not locate the passage starting "${action.find.slice(0, 40)}". Read the document and use the exact text.`,
          done: false,
        };
      }
      case 'insert_table':
        await insertTable(filePath, action.rows, action.cols, action.data);
        return { observation: `Inserted a ${action.rows}×${action.cols} table.`, done: false };
      case 'set_cells': {
        const n = await setCells(filePath, action.start, action.values, action.sheet);
        return { observation: `Wrote ${n} cell(s) starting at ${action.start}.`, done: false };
      }
      case 'run_office_api': {
        const result = await runOfficeScript(filePath, action.code);
        return {
          observation: result.length > 0 ? `Office API ran. Result: ${result.slice(0, 500)}` : 'Office API ran.',
          done: false,
        };
      }
      default:
        return { observation: 'Unknown tool.', done: false };
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { observation: `Tool error: ${message}`, done: false };
  }
};

/** Extract the first JSON object from a model reply (handles fenced blocks). */
export const extractActionJson = (reply: string): unknown => {
  // Prefer a ```json fenced block; else the first balanced {...}.
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : reply;
  const start = candidate.indexOf('{');
  if (start === -1) return null;
  // Walk to the matching closing brace to tolerate trailing prose.
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};
