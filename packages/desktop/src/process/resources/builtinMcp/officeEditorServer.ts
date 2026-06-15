/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in Office-editor MCP server — the **Agent plane** for the Studio editor.
 *
 * Lets a CLI agent (Claude Code / Codex / Gemini …) edit the LIVE document the
 * user has open in the Studio editor, with fast, formatting-preserving tools.
 * The editor chat (`renderer/pages/studio/components/DocAssistantPanel.tsx`)
 * embeds the main `<ChatConversation>` and attaches this server, so "ask the
 * assistant to edit this file" is now the same full chat as the main app, plus
 * real document-editing tools.
 *
 * ## How it reaches the live editor
 *
 * ONLYOFFICE runs in the renderer; MCP servers run in Main. Each tool maps to an
 * {@link EditorToolAction} and calls {@link runEditorTool}, which `invoke`s the
 * renderer-registered editor-tools provider over the symmetric platform bridge.
 * The renderer dispatches the action to `onlyOfficeConnector` against the live
 * editor and returns a short observation. When no editor is open the tool
 * returns a clear "open the document first" error instead of hanging.
 *
 * ## Design mirrors automationMcpServer.ts
 *
 * - Factory `createOfficeEditorServer(deps)` — the single injected dep is the
 *   `runTool` invoker, so the server is pure and testable without a live editor.
 * - `McpServer` from the MCP SDK; Zod schemas per tool; `office_*` snake_case
 *   names (match `^[a-zA-Z0-9_-]+$` required by function calling).
 *
 * Process boundary: Main-process (Node.js / Electron) module — no DOM APIs.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { EditorToolAction, EditorToolRunResult } from '@process/editor/editorToolsBridge';

/** Canonical MCP server name for the built-in Office-editor server. */
export const BUILTIN_OFFICE_EDITOR_NAME = 'aionui-office-editor';

/** Stable identifier (parity with the other built-in server constants). */
export const BUILTIN_OFFICE_EDITOR_ID = 'builtin-office-editor';

/**
 * The slice of the editor-tools bridge this server needs. Declared structurally
 * so the factory stays pure and testable; the host injects the real invoker
 * ({@link runEditorTool}), tests inject a fake.
 */
export type OfficeEditorServerDeps = {
  /** Run one editor action against the live document for `filePath`. */
  runTool: (filePath: string, action: EditorToolAction) => Promise<EditorToolRunResult>;
};

/** Standard MCP text payload, optionally flagged as an error. */
const textResult = (
  text: string,
  isError = false
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } => ({
  content: [{ type: 'text' as const, text }],
  ...(isError ? { isError: true } : {}),
});

/** Zod schema for the shared text-format object. */
const formatSchema = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikeout: z.boolean().optional(),
    color: z.string().optional().describe('Hex text color, e.g. "#C00000".'),
    highlight: z.string().optional().describe('Hex highlight color, e.g. "#FFFF00".'),
    fontSize: z.number().optional().describe('Font size in points.'),
    fontFamily: z.string().optional().describe('Font family name, e.g. "Times New Roman".'),
  })
  .describe('Character/paragraph formatting to apply.');

/**
 * Build the Office-editor {@link McpServer} bound to the injected deps.
 *
 * @param deps The editor-tools invoker (real bridge in production, fake in tests).
 * @returns A configured MCP server; the caller (host) connects a transport.
 */
export const createOfficeEditorServer = (deps: OfficeEditorServerDeps): McpServer => {
  const server = new McpServer({ name: BUILTIN_OFFICE_EDITOR_NAME, version: '1.0.0' });

  /** Run an action and project the result envelope onto an MCP text payload. */
  const run = async (filePath: string, action: EditorToolAction) => {
    const result = await deps.runTool(filePath, action);
    if (result.ok) return textResult(result.observation);
    // strictNullChecks is off in the root tsconfig, so TS does not narrow the
    // `{ ok: false }` branch of the union; cast locally to read `error`.
    return textResult((result as Extract<EditorToolRunResult, { ok: false }>).error, true);
  };

  // --- office_read_document ------------------------------------------------
  server.tool(
    'office_read_document',
    `Read the current plain text of the document open in the Studio editor. Call this first when you
need to know the document's content before editing it.

Input:
- filePath: absolute path of the open document (required).`,
    {
      filePath: z.string().describe('Absolute path of the open document.'),
    },
    ({ filePath }) => run(filePath, { tool: 'read_document' })
  );

  // --- office_search_replace -----------------------------------------------
  server.tool(
    'office_search_replace',
    `Replace EVERY occurrence of a string in the document. Works for Word, spreadsheet and slides.

Input:
- filePath: absolute path of the open document (required)
- search: the exact text to find (required)
- replace: the replacement text (required).`,
    {
      filePath: z.string().describe('Absolute path of the open document.'),
      search: z.string().describe('Exact text to find.'),
      replace: z.string().describe('Replacement text.'),
    },
    ({ filePath, search, replace }) => run(filePath, { tool: 'search_replace', search, replace })
  );

  // --- office_replace_passage ----------------------------------------------
  server.tool(
    'office_replace_passage',
    `Replace ONE specific passage (Word only), located by an anchor — the reliable way to edit a
particular paragraph. With "find" alone it replaces the FIRST occurrence. With "find"+"until" it
replaces everything from the start of "find" through the end of the first following "until" — pass
the first words as "find" and the last words as "until" to target a long paragraph.

Input:
- filePath (required), find (required), replacement (required), until (optional).`,
    {
      filePath: z.string().describe('Absolute path of the open document.'),
      find: z.string().describe('Anchor text at the start of the passage.'),
      replacement: z.string().describe('Text to write in place of the passage.'),
      until: z.string().optional().describe('Anchor text at the end of the passage (for long passages).'),
    },
    ({ filePath, find, replacement, until }) =>
      run(filePath, { tool: 'replace_passage', find, replacement, ...(until !== undefined ? { until } : {}) })
  );

  // --- office_insert_text --------------------------------------------------
  server.tool(
    'office_insert_text',
    `Insert/paste text at the current cursor (replacing any selection).

Input:
- filePath (required), text (required).`,
    {
      filePath: z.string().describe('Absolute path of the open document.'),
      text: z.string().describe('Text to insert at the cursor.'),
    },
    ({ filePath, text }) => run(filePath, { tool: 'insert_text', text })
  );

  // --- office_append_text --------------------------------------------------
  server.tool(
    'office_append_text',
    `Append a paragraph at the end of the document (Word only).

Input:
- filePath (required), text (required).`,
    {
      filePath: z.string().describe('Absolute path of the open document.'),
      text: z.string().describe('Paragraph text to append.'),
    },
    ({ filePath, text }) => run(filePath, { tool: 'append_text', text })
  );

  // --- office_replace_all --------------------------------------------------
  server.tool(
    'office_replace_all',
    `Replace the WHOLE document with new text (Word only). Use only when rewriting the entire
document; prefer office_search_replace / office_replace_passage for targeted edits.

Input:
- filePath (required), text (required) — the complete new document text.`,
    {
      filePath: z.string().describe('Absolute path of the open document.'),
      text: z.string().describe('Complete new document text.'),
    },
    ({ filePath, text }) => run(filePath, { tool: 'replace_all', text })
  );

  // --- office_apply_headings -----------------------------------------------
  server.tool(
    'office_apply_headings',
    `Apply real heading styles (Heading 1–9) to paragraphs by their exact text (Word only). Use this
to mark section titles so a table of contents can pick them up.

Input:
- filePath (required)
- headings: array of { text: exact paragraph text, level: 1–9 } (required).`,
    {
      filePath: z.string().describe('Absolute path of the open document.'),
      headings: z
        .array(z.object({ text: z.string(), level: z.number() }))
        .describe('Paragraphs to style: { text, level 1–9 }.'),
    },
    ({ filePath, headings }) =>
      run(filePath, {
        tool: 'apply_headings',
        headings: headings.map((h) => ({ text: String(h.text), level: Number(h.level) })),
      })
  );

  // --- office_insert_toc ---------------------------------------------------
  server.tool(
    'office_insert_toc',
    `Insert a real, auto-updating Table of Contents from the heading-styled paragraphs (Word only).
Apply headings FIRST (office_apply_headings).

Input:
- filePath (required)
- atStart: insert at the document start (optional, default true).`,
    {
      filePath: z.string().describe('Absolute path of the open document.'),
      atStart: z.boolean().optional().describe('Insert at the document start (default true).'),
    },
    ({ filePath, atStart }) => run(filePath, { tool: 'insert_toc', ...(atStart !== undefined ? { atStart } : {}) })
  );

  // --- office_format_text --------------------------------------------------
  server.tool(
    'office_format_text',
    `Apply character formatting to EVERY occurrence of a string (Word only): bold/italic/underline/
strikeout/color/highlight/fontSize/fontFamily.

Input:
- filePath (required), search (required), format (required).`,
    {
      filePath: z.string().describe('Absolute path of the open document.'),
      search: z.string().describe('Exact text to format.'),
      format: formatSchema,
    },
    ({ filePath, search, format }) => run(filePath, { tool: 'format_text', search, format })
  );

  // --- office_format_passage -----------------------------------------------
  server.tool(
    'office_format_passage',
    `Format ONE specific passage (Word only), located by an anchor — like selecting the whole
paragraph then applying bold/italic/etc. "find" alone targets the first occurrence; "find"+"until"
covers a long passage (first words as "find", last words as "until").

Input:
- filePath (required), find (required), format (required), until (optional).`,
    {
      filePath: z.string().describe('Absolute path of the open document.'),
      find: z.string().describe('Anchor text at the start of the passage.'),
      format: formatSchema,
      until: z.string().optional().describe('Anchor text at the end of the passage (for long passages).'),
    },
    ({ filePath, find, format, until }) =>
      run(filePath, { tool: 'format_passage', find, format, ...(until !== undefined ? { until } : {}) })
  );

  // --- office_insert_table -------------------------------------------------
  server.tool(
    'office_insert_table',
    `Insert a table at the end of the document (Word only). When "data" is given it fills the cells
and sets the size.

Input:
- filePath (required), rows (required), cols (required), data (optional 2D string array).`,
    {
      filePath: z.string().describe('Absolute path of the open document.'),
      rows: z.number().describe('Number of rows (>= 1).'),
      cols: z.number().describe('Number of columns (>= 1).'),
      data: z.array(z.array(z.string())).optional().describe('Optional cell values, row by row.'),
    },
    ({ filePath, rows, cols, data }) =>
      run(filePath, { tool: 'insert_table', rows, cols, ...(data !== undefined ? { data } : {}) })
  );

  // --- office_set_cells ----------------------------------------------------
  server.tool(
    'office_set_cells',
    `Write a block of spreadsheet cells (spreadsheet only). Values are written row-by-row from the
"start" cell.

Input:
- filePath (required), start (e.g. "A1", required), values (2D array, required), sheet (optional).`,
    {
      filePath: z.string().describe('Absolute path of the open document.'),
      start: z.string().describe('Top-left cell reference, e.g. "A1".'),
      values: z.array(z.array(z.union([z.string(), z.number()]))).describe('2D array of values written from "start".'),
      sheet: z.string().optional().describe('Sheet name (defaults to the active sheet).'),
    },
    ({ filePath, start, values, sheet }) =>
      run(filePath, { tool: 'set_cells', start, values, ...(sheet !== undefined ? { sheet } : {}) })
  );

  // --- office_run_api ------------------------------------------------------
  server.tool(
    'office_run_api',
    `Run ANY ONLYOFFICE Document Builder API script in the live editor — the "do anything Office can
do" tool for things the specific tools above do not cover (tables, images, charts, fonts/colors,
page setup, sections, comments, complex formatting).

"code" is a JS function body that uses the editor global \`Api\` and may \`return\` a JSON-serializable
value. Word: \`Api.GetDocument()\`; Spreadsheet: \`Api.GetActiveSheet()\`; Presentation:
\`Api.GetPresentation()\`. It is sandboxed to the document (no file/network/Node access).

Input:
- filePath (required), code (required).`,
    {
      filePath: z.string().describe('Absolute path of the open document.'),
      code: z.string().describe('Document Builder API script body (uses the global `Api`).'),
    },
    ({ filePath, code }) => run(filePath, { tool: 'run_office_api', code })
  );

  return server;
};
