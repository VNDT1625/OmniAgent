/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in IDE MCP server — the **Agent plane** for the IDE / repo-intelligence
 * features.
 *
 * The IDE plane (`process/ide/*`) exposes rich repo capabilities to the renderer
 * UI: scan a repo into an import graph, grep across files, jump to a symbol's
 * definition / references, list directories, and read files anywhere on disk
 * (not just the conversation workspace). Until now those were UI-only — an agent
 * (a company role, a CLI engine, an assistant) had no "first-class" way to use
 * them, unlike Browser / Testing / Office / Cron / Manager which all ship a
 * built-in MCP server. This server closes that gap so a company role can be
 * granted "IDE powers" exactly like any other capability (Requirement 9): it
 * appears in the MCP catalog as a built-in `sse` server and is attachable to a
 * role through the company capability flow.
 *
 * ## Same plumbing as the other built-in servers
 *
 * - Factory `createIdeServer(deps)` — the single injected dep is an
 *   {@link IdeMcpService}, so the server is pure and unit-testable without Node
 *   `fs`. The host (`ideMcpWiring.ts`) injects the real, fs-backed service.
 * - `McpServer` from the MCP SDK; Zod schemas per tool; `ide_*` snake_case names
 *   (match `^[a-zA-Z0-9_-]+$` required by function calling).
 *
 * Process boundary: Main-process (Node.js / Electron) module — no DOM APIs.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ISessionMemoryStore } from '../memory/sessionMemoryStore';

/**
 * The session super-memory slice the agent tools use. Structurally satisfied by
 * the real {@link ISessionMemoryStore} (the wiring injects the singleton), so
 * the server stays decoupled and unit-testable with a fake.
 */
export type SessionMemoryAgentService = Pick<
  ISessionMemoryStore,
  'remember' | 'recall' | 'forget' | 'setSecret' | 'listSecretKeys' | 'deleteSecret' | 'snapshot'
>;

/** Canonical MCP server name for the built-in IDE server. */
export const BUILTIN_IDE_NAME = 'aionui-ide';

/** Stable identifier (parity with the other built-in server constants). */
export const BUILTIN_IDE_ID = 'builtin-ide';

/** One entry returned by {@link IdeMcpService.listDir}. */
export type IdeDirEntry = { name: string; fullPath: string; isDir: boolean };

/** One grep hit returned by {@link IdeMcpService.search}. */
export type IdeSearchHit = { file: string; line: number; text: string };

/** One symbol hit returned by {@link IdeMcpService.findDefinition}/`findReferences`. */
export type IdeSymbolHit = { file: string; line: number; column: number; text: string };

/** A compact summary of a scanned repo's import graph. */
export type IdeRepoSummary = {
  /** Number of files in the graph. */
  fileCount: number;
  /** Number of intra-repo import edges. */
  edgeCount: number;
  /** Top folder groups by file count (for an at-a-glance layout). */
  topGroups: Array<{ group: string; files: number }>;
  /** Whether the scan hit its file cap (results may be partial). */
  truncated: boolean;
};

/** Options for {@link IdeMcpService.search}. */
export type IdeSearchOptions = {
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  maxResults?: number;
};

/**
 * The IDE capabilities this server exposes. Declared structurally so the factory
 * stays pure and testable; the host injects the real fs-backed implementation
 * (see `ideMcpWiring.ts`), tests inject a fake.
 */
export type IdeMcpService = {
  /** List one directory level (dirs first, then files). */
  listDir: (dir: string) => Promise<IdeDirEntry[]>;
  /** Read a file's UTF-8 text (optionally capped to `maxBytes`). */
  readFile: (filePath: string, maxBytes?: number) => Promise<string>;
  /** Scan a repo folder into a compact import-graph summary. */
  scanRepo: (rootPath: string, maxFiles?: number) => Promise<IdeRepoSummary>;
  /** Grep the repo for `query` (literal by default; regex/word/case via opts). */
  search: (rootPath: string, query: string, opts?: IdeSearchOptions) => Promise<IdeSearchHit[]>;
  /** Find DECLARATION sites of `name` across the repo (go-to-definition). */
  findDefinition: (rootPath: string, name: string, maxResults?: number) => Promise<IdeSymbolHit[]>;
  /** Find whole-word REFERENCES of `name` across the repo. */
  findReferences: (rootPath: string, name: string, maxResults?: number) => Promise<IdeSymbolHit[]>;
};

/** Injected collaborators for {@link createIdeServer}. */
export type IdeServerDeps = {
  /** The fs-backed IDE service (real in production, faked in tests). */
  ide: IdeMcpService;
  /**
   * Optional Quick Test runner (Agent plane). When present, the server exposes
   * an `ide_quick_test` tool so an agent can run a bounded, observed Quick Test
   * session (web CDP / android logcat / windows stdio) and get the trace +
   * suspected files. Omitted in pure unit tests that don't need it.
   */
  quickTest?: QuickTestRunner;
  /**
   * Optional Database accessor (Agent plane). When present, the server exposes
   * `db_*` tools so an agent can list connections, inspect the schema, and run
   * SQL against the open repo's database(s). Omitted in tests that don't need it.
   */
  db?: DbAgentService;
  /**
   * Optional session super-memory (Agent plane). When present, the server
   * exposes `ide_memory_*` tools so an IDE agent can keep an EPHEMERAL,
   * per-session scratchpad (facts/decisions/todos + short-lived secrets) that is
   * auto-compacted at a token budget and discarded when the chat tab closes.
   * Omitted in tests that don't need it.
   */
  memory?: SessionMemoryAgentService;
};

/** The subset of the Database service the agent tools need. */
export type DbAgentService = {
  listConnections: (rootPath?: string) => Promise<Array<{ config: { id: string; name: string; kind: string; readOnly?: boolean } }>>;
  connect: (id: string) => Promise<void>;
  listTables: (id: string) => Promise<Array<{ schema?: string; name: string; type: string; rowCount?: number }>>;
  getColumns: (id: string, table: string, schema?: string) => Promise<Array<{ name: string; type: string; nullable: boolean; primaryKey: boolean }>>;
  getTableDetail: (
    id: string,
    table: string,
    schema?: string
  ) => Promise<{
    columns: Array<{ name: string; type: string; nullable: boolean; primaryKey: boolean }>;
    indexes: Array<{ name: string; columns: string[]; unique: boolean; primary?: boolean }>;
    foreignKeys: Array<{ name: string; columns: string[]; referencedTable: string; referencedSchema?: string; referencedColumns: string[] }>;
  }>;
  query: (
    id: string,
    sql: string,
    options?: { params?: Array<string | number | boolean | null>; maxRows?: number }
  ) => Promise<{
    columns: string[];
    rows: Array<Array<string | number | boolean | null>>;
    rowsAffected?: number;
    durationMs: number;
    truncated: boolean;
  }>;
};

/** A bounded one-shot Quick Test the agent can invoke (subset of `QuickTestService`). */
export type QuickTestRunner = {
  runSession: (req: {
    platform: 'web' | 'android' | 'windows';
    rootPath: string;
    target?: string;
    durationMs?: number;
  }) => Promise<{
    trace: {
      platform: string;
      events: Array<{ kind: string; at: number } & Record<string, unknown>>;
      firstError: ({ kind: string } & Record<string, unknown>) | null;
      startedAt: number;
      stoppedAt: number;
    };
    contextPack: { slices: Array<{ path: string; layer: string }>; renderedContext: string } | null;
  }>;
};

/** Standard MCP text payload, optionally flagged as an error. */
const textResult = (
  text: string,
  isError = false
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } => ({
  content: [{ type: 'text' as const, text }],
  ...(isError ? { isError: true } : {}),
});

/** Run a service call and project its result (or error) onto an MCP payload. */
const guard = async (fn: () => Promise<string>): Promise<ReturnType<typeof textResult>> => {
  try {
    return textResult(await fn());
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
};

/** Render a list of grep hits as a compact, agent-friendly text block. */
const renderSearchHits = (hits: IdeSearchHit[]): string => {
  if (hits.length === 0) return 'No matches found.';
  return [`${hits.length} match(es):`, ...hits.map((h) => `${h.file}:${h.line}: ${h.text}`)].join('\n');
};

/** Render a list of symbol hits as a compact, agent-friendly text block. */
const renderSymbolHits = (hits: IdeSymbolHit[], label: string): string => {
  if (hits.length === 0) return `No ${label} found.`;
  return [`${hits.length} ${label}:`, ...hits.map((h) => `${h.file}:${h.line}:${h.column}: ${h.text}`)].join('\n');
};

/** Render one labelled section of a memory recall (empty string when no items). */
const renderRecallSection = (label: string, items: Array<{ kind: string; id: string; text: string }>): string => {
  if (items.length === 0) return '';
  return [`## ${label}`, ...items.map((it) => `- [${it.kind}] (${it.id}) ${it.text}`)].join('\n');
};

/**
 * Build the IDE {@link McpServer} bound to the injected service.
 *
 * @param deps The IDE service (real fs-backed bridge in production, fake in tests).
 * @returns A configured MCP server; the caller (host) connects a transport.
 */
export const createIdeServer = (deps: IdeServerDeps): McpServer => {
  const { ide } = deps;
  const server = new McpServer({ name: BUILTIN_IDE_NAME, version: '1.0.0' });

  // --- ide_list_dir --------------------------------------------------------
  server.tool(
    'ide_list_dir',
    `List the entries of one directory on disk (directories first, then files). Use this to explore an
arbitrary project folder — not limited to the conversation workspace.

Input:
- dir: absolute path of the folder to list (required).`,
    { dir: z.string().describe('Absolute path of the folder to list.') },
    ({ dir }) =>
      guard(async () => {
        const entries = await ide.listDir(dir);
        if (entries.length === 0) return 'The directory is empty.';
        return entries.map((e) => `${e.isDir ? '[dir] ' : '      '}${e.name}`).join('\n');
      })
  );

  // --- ide_read_file -------------------------------------------------------
  server.tool(
    'ide_read_file',
    `Read the UTF-8 text content of a file anywhere on disk. Use this to inspect a source file before
editing or to gather context.

Input:
- filePath: absolute path of the file (required)
- maxBytes: optional cap on bytes returned (default reads the whole file).`,
    {
      filePath: z.string().describe('Absolute path of the file to read.'),
      maxBytes: z.number().optional().describe('Optional cap on the number of bytes returned.'),
    },
    ({ filePath, maxBytes }) => guard(() => ide.readFile(filePath, maxBytes))
  );

  // --- ide_search ----------------------------------------------------------
  server.tool(
    'ide_search',
    `Search (grep) across a repository for a query. Literal by default; enable regex / whole-word /
case-sensitive via options. Returns matching "file:line: text" entries.

Input:
- rootPath: absolute path of the repo/folder to search (required)
- query: the text or pattern to find (required)
- regex / wholeWord / caseSensitive: optional booleans
- maxResults: optional cap on the number of matches (default 200).`,
    {
      rootPath: z.string().describe('Absolute path of the repo/folder to search.'),
      query: z.string().describe('Text or pattern to find.'),
      regex: z.boolean().optional().describe('Treat the query as a regular expression.'),
      wholeWord: z.boolean().optional().describe('Match whole words only.'),
      caseSensitive: z.boolean().optional().describe('Case-sensitive match.'),
      maxResults: z.number().optional().describe('Cap on the number of matches (default 200).'),
    },
    ({ rootPath, query, regex, wholeWord, caseSensitive, maxResults }) =>
      guard(async () =>
        renderSearchHits(await ide.search(rootPath, query, { regex, wholeWord, caseSensitive, maxResults }))
      )
  );

  // --- ide_find_definition -------------------------------------------------
  server.tool(
    'ide_find_definition',
    `Find where a symbol (function/class/const/type/interface/enum/import) is DECLARED across the repo
— "go to definition". Language-agnostic heuristic for TS/JS-style code.

Input:
- rootPath: absolute path of the repo/folder (required)
- name: the identifier to locate (required)
- maxResults: optional cap (default 50).`,
    {
      rootPath: z.string().describe('Absolute path of the repo/folder.'),
      name: z.string().describe('Identifier to locate the declaration of.'),
      maxResults: z.number().optional().describe('Cap on the number of hits (default 50).'),
    },
    ({ rootPath, name, maxResults }) =>
      guard(async () => renderSymbolHits(await ide.findDefinition(rootPath, name, maxResults), 'definition(s)'))
  );

  // --- ide_find_references -------------------------------------------------
  server.tool(
    'ide_find_references',
    `Find all whole-word REFERENCES of an identifier across the repo — "find references".

Input:
- rootPath: absolute path of the repo/folder (required)
- name: the identifier to search for (required)
- maxResults: optional cap (default 200).`,
    {
      rootPath: z.string().describe('Absolute path of the repo/folder.'),
      name: z.string().describe('Identifier to find references of.'),
      maxResults: z.number().optional().describe('Cap on the number of hits (default 200).'),
    },
    ({ rootPath, name, maxResults }) =>
      guard(async () => renderSymbolHits(await ide.findReferences(rootPath, name, maxResults), 'reference(s)'))
  );

  // --- ide_scan_repo -------------------------------------------------------
  server.tool(
    'ide_scan_repo',
    `Scan a repository into a compact import-graph summary: file count, intra-repo import edges, and
the top folder groups. Use this to understand a project's shape before diving in.

Input:
- rootPath: absolute path of the repo/folder (required)
- maxFiles: optional hard cap on files walked.`,
    {
      rootPath: z.string().describe('Absolute path of the repo/folder to scan.'),
      maxFiles: z.number().optional().describe('Optional hard cap on the number of files walked.'),
    },
    ({ rootPath, maxFiles }) =>
      guard(async () => {
        const s = await ide.scanRepo(rootPath, maxFiles);
        const groups = s.topGroups.map((g) => `- ${g.group}: ${g.files} file(s)`).join('\n');
        return [
          `Files: ${s.fileCount}`,
          `Import edges: ${s.edgeCount}`,
          s.truncated ? '(scan truncated at the file cap — results are partial)' : '',
          groups ? `Top groups:\n${groups}` : '',
        ]
          .filter((l) => l.length > 0)
          .join('\n');
      })
  );

  // --- ide_quick_test ------------------------------------------------------
  // Only exposed when a Quick Test runner is injected (production wiring).
  if (deps.quickTest) {
    const quickTest = deps.quickTest;
    server.tool(
      'ide_quick_test',
      `Run a bounded "Quick Test" session and get the runtime trace + the suspected source files mapped
to the repo's code graph. This is the "run the app, watch what breaks" capability: it records DOM
clicks / network / console / exceptions (web) or the app's log stream (android/windows) for a short
window, stopping early as soon as the first error appears.

You are expected to EXERCISE the app yourself during the window (e.g. navigate a page with the
browser-control tools, or tap around an emulator). This tool is the passive recorder + code mapper.

Input:
- platform: 'web' | 'android' | 'windows' (required)
- rootPath: absolute repo root the trace maps against (required)
- target: android device serial OR Windows .exe path (ignored for web)
- durationMs: observation window in ms (default 8000, max 60000)

Returns JSON: the first error (if any), the interaction/log path, and the suspected files.`,
      {
        platform: z.enum(['web', 'android', 'windows']).describe('Target platform to observe.'),
        rootPath: z.string().describe('Absolute repo root the trace is mapped against.'),
        target: z.string().optional().describe('Android device serial or Windows .exe path (ignored for web).'),
        durationMs: z.number().optional().describe('Observation window in ms (default 8000, max 60000).'),
      },
      ({ platform, rootPath, target, durationMs }) =>
        guard(async () => {
          const { trace, contextPack } = await quickTest.runSession({ platform, rootPath, target, durationMs });
          const summary = {
            platform: trace.platform,
            durationMs: trace.stoppedAt - trace.startedAt,
            eventCount: trace.events.length,
            firstError: trace.firstError,
            suspectedFiles: contextPack?.slices.map((s) => ({ path: s.path, layer: s.layer })) ?? [],
            context: contextPack?.renderedContext ?? null,
          };
          return JSON.stringify(summary, null, 2);
        })
    );
  }

  // --- db_* (Database — Agent plane) ---------------------------------------
  // Only exposed when a Database accessor is injected (production wiring).
  if (deps.db) {
    const db = deps.db;

    server.tool(
      'db_list_connections',
      `List the database connections saved for the open repo. Each entry has an id (use it for the other
db_* tools), a name, the engine (sqlite/postgres/mysql), and whether it is read-only.

Input:
- rootPath: optional repo root to scope the list.`,
      { rootPath: z.string().optional().describe('Optional repo root to scope the connection list.') },
      ({ rootPath }) =>
        guard(async () => {
          const conns = await db.listConnections(rootPath);
          if (conns.length === 0) return 'No database connections are saved. Add one in the IDE Database panel.';
          return JSON.stringify(
            conns.map((c) => ({ id: c.config.id, name: c.config.name, kind: c.config.kind, readOnly: c.config.readOnly !== false })),
            null,
            2
          );
        })
    );

    server.tool(
      'db_list_tables',
      `List the tables and views of a connected database. Opens the connection if needed.

Input:
- id: the connection id from db_list_connections (required).`,
      { id: z.string().describe('Connection id from db_list_connections.') },
      ({ id }) =>
        guard(async () => {
          await db.connect(id);
          const tables = await db.listTables(id);
          if (tables.length === 0) return 'The database has no tables.';
          return tables.map((t) => `${t.type === 'view' ? '[view] ' : ''}${t.schema ? `${t.schema}.` : ''}${t.name}`).join('\n');
        })
    );

    server.tool(
      'db_describe_table',
      `Describe one table in full: its columns (types, nullability, primary keys), its indexes, and its
outgoing foreign keys. Use this to understand a table's shape + relationships before writing a query.

Input:
- id: connection id (required)
- table: table name (required)
- schema: optional schema/owner (postgres).`,
      {
        id: z.string().describe('Connection id.'),
        table: z.string().describe('Table name to describe.'),
        schema: z.string().optional().describe('Schema/owner (postgres).'),
      },
      ({ id, table, schema }) =>
        guard(async () => {
          await db.connect(id);
          const detail = await db.getTableDetail(id, table, schema);
          if (detail.columns.length === 0) return `No columns found for table "${table}".`;
          const lines: string[] = ['## Columns'];
          lines.push(
            ...detail.columns.map((c) => `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.primaryKey ? ' PK' : ''}`)
          );
          if (detail.indexes.length > 0) {
            lines.push('', '## Indexes');
            lines.push(
              ...detail.indexes.map(
                (ix) => `${ix.name} (${ix.columns.join(', ')})${ix.unique ? ' UNIQUE' : ''}${ix.primary ? ' PRIMARY' : ''}`
              )
            );
          }
          if (detail.foreignKeys.length > 0) {
            lines.push('', '## Foreign keys');
            lines.push(
              ...detail.foreignKeys.map(
                (fk) =>
                  `${fk.columns.join(', ')} -> ${fk.referencedSchema ? `${fk.referencedSchema}.` : ''}${fk.referencedTable}(${fk.referencedColumns.join(', ')})`
              )
            );
          }
          return lines.join('\n');
        })
    );

    server.tool(
      'db_query',
      `Run a SQL statement against a connection and get the rows back as JSON. The connection's read-only
guard is enforced server-side: if it is read-only, only SELECT/WITH/EXPLAIN/SHOW/PRAGMA statements are
allowed (writes are rejected). Results are capped (default 1000 rows).

Prefer PARAMETERISED queries: put placeholders in the SQL and pass values in "params" to avoid SQL
injection (sqlite/postgres use $1.. or ?, mysql uses ?).

Input:
- id: connection id (required)
- sql: the SQL statement (required)
- params: optional positional bound parameters
- maxRows: optional cap on returned rows (default 1000).`,
      {
        id: z.string().describe('Connection id.'),
        sql: z.string().describe('SQL statement to run.'),
        params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Positional bound parameters.'),
        maxRows: z.number().optional().describe('Cap on returned rows (default 1000).'),
      },
      ({ id, sql, params, maxRows }) =>
        guard(async () => {
          await db.connect(id);
          const result = await db.query(id, sql, { params, maxRows });
          return JSON.stringify(
            {
              columns: result.columns,
              rowCount: result.rows.length,
              rows: result.rows,
              rowsAffected: result.rowsAffected,
              durationMs: result.durationMs,
              truncated: result.truncated,
            },
            null,
            2
          );
        })
    );
  }

  // --- ide_memory_* (Session super-memory — Agent plane) -------------------
  // Only exposed when a session-memory store is injected (production wiring).
  if (deps.memory) {
    const memory = deps.memory;
    const kindEnum = z.enum(['fact', 'decision', 'todo', 'snippet', 'note']);

    server.tool(
      'ide_memory_remember',
      `Save a short note to your EPHEMERAL session memory — a scratchpad that lives only while this chat
session is open and is wiped when the tab closes. Use it to remember the few things you must NOT
re-derive every turn: a decision you made, a fact you had to dig for that the repo map does not
surface, a running TODO. Do NOT dump large file contents here (the repo/MTUI map already holds that)
— keep notes short. The memory auto-summarises older notes when it gets large, so prefer many small
notes over one giant one. Pin only truly critical facts (pinned notes survive summarisation).

Input:
- sessionId: your session memory id (given to you in the workspace guide) (required)
- text: the note to remember (required, keep it short)
- kind: 'fact' | 'decision' | 'todo' | 'snippet' | 'note' (default 'note')
- pinned: true to protect this note from auto-summarisation (default false).`,
      {
        sessionId: z.string().describe('Your session memory id (from the workspace guide).'),
        text: z.string().describe('The short note to remember.'),
        kind: kindEnum.optional().describe("Category: fact | decision | todo | snippet | note (default 'note')."),
        pinned: z.boolean().optional().describe('Protect this note from auto-summarisation.'),
      },
      ({ sessionId, text, kind, pinned }) =>
        guard(async () => {
          const result = await memory.remember(sessionId, { text, kind, pinned });
          const pct = Math.round((result.tokensUsed / result.tokenBudget) * 100);
          return [
            `Saved note ${result.item.id} (${result.item.kind}${result.item.pinned ? ', pinned' : ''}).`,
            result.deduped ? 'Merged into an existing near-identical note (no duplicate stored).' : '',
            result.truncated ? 'Note was long and got truncated — keep notes short (the repo map already holds file contents).' : '',
            `Memory usage: ~${result.tokensUsed}/${result.tokenBudget} tokens (${pct}%).`,
            result.compacted ? 'Older notes were auto-summarised to stay within budget.' : '',
          ]
            .filter((line) => line.length > 0)
            .join('\n');
        })
    );

    server.tool(
      'ide_memory_recall',
      `Read back your session memory as a compact context block: the auto-generated summaries of older
notes, your pinned notes, and the most recent / matching notes. Call this at the start of a turn (or
when you are unsure whether you already know something) BEFORE re-searching the repo.

Input:
- sessionId: your session memory id (required)
- query: optional text to filter recent notes (case-insensitive substring)
- limit: optional cap on recent notes returned.`,
      {
        sessionId: z.string().describe('Your session memory id.'),
        query: z.string().optional().describe('Optional substring to filter recent notes.'),
        limit: z.number().optional().describe('Cap on recent notes returned.'),
      },
      ({ sessionId, query, limit }) =>
        guard(async () => {
          const recall = memory.recall(sessionId, { query, limit });
          const blocks = [
            renderRecallSection('Summaries (older notes condensed)', recall.summaries),
            renderRecallSection('Pinned', recall.pinned),
            renderRecallSection(query ? `Recent matching "${query}"` : 'Recent', recall.recent),
            recall.secretKeys.length > 0 ? `## Secret keys available\n${recall.secretKeys.map((k) => `- ${k}`).join('\n')}` : '',
          ].filter((block) => block.length > 0);
          return blocks.length > 0 ? blocks.join('\n\n') : 'Session memory is empty.';
        })
    );

    server.tool(
      'ide_memory_forget',
      `Delete one note from your session memory by its id (the id shown by ide_memory_remember /
ide_memory_recall).

Input:
- sessionId: your session memory id (required)
- id: the note id to forget (required).`,
      {
        sessionId: z.string().describe('Your session memory id.'),
        id: z.string().describe('The note id to delete.'),
      },
      ({ sessionId, id }) =>
        guard(async () => (memory.forget(sessionId, id) ? `Forgot note ${id}.` : `No note ${id} to forget.`))
    );

    server.tool(
      'ide_memory_set_secret',
      `Store a SHORT-LIVED secret (e.g. an API key the user pasted for this session only) in session
memory. The value lives in RAM only, is NEVER written to disk, is NEVER shown in recalls, and is wiped
when the chat tab closes. Read it back with ide_memory_get_secret when you actually need to use it.

Input:
- sessionId: your session memory id (required)
- key: a name for the secret (e.g. 'OPENAI_API_KEY') (required)
- value: the secret value (required).`,
      {
        sessionId: z.string().describe('Your session memory id.'),
        key: z.string().describe("Secret name, e.g. 'OPENAI_API_KEY'."),
        value: z.string().describe('The secret value (kept in RAM only).'),
      },
      ({ sessionId, key, value }) =>
        guard(async () => {
          memory.setSecret(sessionId, key, value);
          return `Stored secret "${key}" for this session (RAM only; cleared when the tab closes).`;
        })
    );

    server.tool(
      'ide_memory_status',
      `Show your session memory status: note count, summaries, token usage vs budget, and the names of
any stored secrets (values are never shown).

Input:
- sessionId: your session memory id (required).`,
      { sessionId: z.string().describe('Your session memory id.') },
      ({ sessionId }) =>
        guard(async () => {
          const snap = memory.snapshot(sessionId);
          const summaries = snap.items.filter((it) => it.kind === 'summary').length;
          const pinned = snap.items.filter((it) => it.pinned).length;
          const pct = snap.tokenBudget > 0 ? Math.round((snap.tokensUsed / snap.tokenBudget) * 100) : 0;
          return JSON.stringify(
            {
              notes: snap.items.length,
              summaries,
              pinned,
              tokensUsed: snap.tokensUsed,
              tokenBudget: snap.tokenBudget,
              usagePercent: pct,
              compactions: snap.compactions,
              deduped: snap.deduped,
              recalls: snap.recalls,
              secretKeys: snap.secretKeys,
            },
            null,
            2
          );
        })
    );
  }

  return server;
};
