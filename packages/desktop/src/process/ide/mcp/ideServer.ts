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
import type { ToolGuard } from './ideServerToolGuard';

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
export type IdeDirEntry = { name: string; fullPath: string; isDir: boolean; relativePath?: string; sizeBytes?: number };

/** One grep hit returned by {@link IdeMcpService.search}. */
export type IdeSearchHit = { file: string; line: number; text: string; column?: number };

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
  /** Glob pattern restricting which files are searched (e.g. `*.ts`). */
  glob?: string;
};

/** Options for {@link IdeMcpService.readFile}. */
export type IdeReadOptions = {
  /** Start line (1-based, inclusive). */
  from?: number;
  /** End line (1-based, inclusive). */
  to?: number;
  /** Cap on returned lines (default 2000). Ignored when `all` is true. */
  maxLines?: number;
  /** Cap on returned bytes/characters. Ignored when `all` is true. */
  maxBytes?: number;
  /** Return the ENTIRE file with no line/byte cap. */
  all?: boolean;
  /** Prefix each returned line with "N: " (default true). */
  lineNumbers?: boolean;
};

/** Structured result of {@link IdeMcpService.readFile}. */
export type IdeReadResult = {
  text: string;
  lineStart: number;
  lineEnd: number;
  totalLines: number;
  returnedLines: number;
  truncated: boolean;
  binary: boolean;
  sizeBytes: number;
};

/** Result of an MTUI-backed understand/summary/map/context/compass query. */
export type IdeMtuiResult = {
  /** The compact, human/agent-readable summary text. */
  summary: string;
  /** The full structured JSON payload from MTUI (for detail). */
  details?: unknown;
  /** True when the underlying Understand cache is stale / fell back to filesystem. */
  stale?: boolean;
};

/**
 * The IDE capabilities this server exposes. Declared structurally so the factory
 * stays pure and testable; the host injects the real fs-backed implementation
 * (see `ideMcpWiring.ts`), tests inject a fake.
 */
export type IdeMcpService = {
  /** List one directory level, or recursively / by glob when options are set. */
  listDir: (dir: string, opts?: { glob?: string; recursive?: boolean; maxResults?: number }) => Promise<IdeDirEntry[]>;
  /** Read a file's UTF-8 text with full Read-tool parity (line range, all, line numbers). */
  readFile: (filePath: string, opts?: IdeReadOptions) => Promise<IdeReadResult>;
  /** Scan a repo folder into a compact import-graph summary. */
  scanRepo: (rootPath: string, maxFiles?: number) => Promise<IdeRepoSummary>;
  /** Grep the repo for `query` (literal by default; regex/word/case/glob via opts). */
  search: (rootPath: string, query: string, opts?: IdeSearchOptions) => Promise<IdeSearchHit[]>;
  /** Find DECLARATION sites of `name` across the repo (go-to-definition). */
  findDefinition: (rootPath: string, name: string, maxResults?: number) => Promise<IdeSymbolHit[]>;
  /** Find whole-word REFERENCES of `name` across the repo. */
  findReferences: (rootPath: string, name: string, maxResults?: number) => Promise<IdeSymbolHit[]>;
  /** MTUI Understand summary of one file or folder (semantic role, layer, symbols). */
  understand: (rootPath: string, target: string, kind: 'file' | 'folder', detailed: boolean) => Promise<IdeMtuiResult>;
  /** MTUI compass read — code-aware compressed slice of a file, focused by intent. */
  compassRead: (rootPath: string, filePath: string, query?: string, maxLines?: number) => Promise<IdeMtuiResult>;
  /** MTUI context — rank repo files by relevance to a natural-language intent. */
  context: (rootPath: string, intent: string, limit?: number) => Promise<IdeMtuiResult>;
  /** MTUI map — module/folder/intent map of the repo. */
  map: (
    rootPath: string,
    scope: 'repo' | 'folder' | 'intent',
    target?: string,
    limit?: number
  ) => Promise<IdeMtuiResult>;
  /** MTUI analyze — detect languages / error-check a path or the whole repo. */
  analyze: (rootPath: string, target?: string) => Promise<IdeMtuiResult>;
  /** MTUI compact — compress noisy build/test logs to the important lines. */
  compact: (rootPath: string, input: string, profile?: string, maxLines?: number) => Promise<IdeMtuiResult>;
  /**
   * Run an arbitrary shell command under guard rails (timeout, output cap,
   * interactive prompts disabled). The escape-hatch for work no structured tool
   * models (`npm install`, `bun run build`, a one-off script). `cwd` is explicit
   * (no hidden `cd` state); output is capped so a long log never floods context.
   */
  runCommand: (
    rootPath: string,
    command: string,
    opts?: { cwd?: string; timeoutMs?: number }
  ) => Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number }>;
};

export type TerminalRunResult = {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
};

export type TerminalRunOptions = {
  cwd?: string;
  timeoutMs?: number;
};

export type TerminalAgentService = {
  run: (command: string, args?: string[], options?: TerminalRunOptions) => Promise<TerminalRunResult>;
};

export type GitAgentService = {
  status: (rootPath: string) => Promise<TerminalRunResult>;
  diff: (rootPath: string, opts?: { staged?: boolean; path?: string; maxBytes?: number }) => Promise<TerminalRunResult>;
  log: (rootPath: string, maxCount?: number) => Promise<TerminalRunResult>;
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
  /**
   * Optional Team Edit coordinator (Agent plane). When present, the server
   * exposes `team_*` tools so several agents (company roles / CLI-agent chat
   * tabs) plus the user can divide work on ONE open workspace WITHOUT clobbering
   * each other: an agent claims a file (an advisory lease) before editing, writes
   * through the guarded MTUI gateway, and releases it when done. Omitted in tests
   * that don't need it.
   */
  teamEdit?: TeamEditAgentService;
  /**
   * Optional per-call tool guard. When supplied (by the Omni External MCP
   * Gateway), every tool registration on this server is transparently wrapped:
   * the guard runs synchronously before the real handler, and a denial returns
   * an MCP `isError:true` result with the reason instead of executing the tool.
   *
   * Internal IDE callers omit this dep, so the behaviour is bit-identical to
   * the pre-gateway server. The wrapper also injects an optional `sessionId`
   * field into each tool's zod schema when one is not already declared, so an
   * external host can echo back the session id issued by `omni_bootstrap_session`.
   */
  toolGuard?: ToolGuard;
  /** Optional process runner for standalone rescue commands. */
  terminal?: TerminalAgentService;
  /** Optional Git helper for standalone rescue commands. */
  git?: GitAgentService;
};

/** The subset of the Team Edit service the agent tools need. */
export type TeamEditAgentService = {
  claim: (
    rootPath: string,
    agentId: string,
    relPath: string,
    intent?: string
  ) => { ok: true; lease: TeamLeaseInfo; renewed: boolean } | { ok: false; reason: 'held'; lease: TeamLeaseInfo };
  release: (rootPath: string, agentId: string, relPath: string) => boolean;
  write: (
    rootPath: string,
    agentId: string,
    relPath: string,
    data: string
  ) => Promise<
    | { ok: true; bytes: number }
    | { ok: false; reason: 'held'; lease: TeamLeaseInfo }
    | { ok: false; reason: 'error'; error: string }
  >;
  editReplace: (
    rootPath: string,
    agentId: string,
    relPath: string,
    oldText: string,
    newText: string
  ) => Promise<
    | { ok: true; matches: number }
    | { ok: false; reason: 'held'; lease: TeamLeaseInfo }
    | { ok: false; reason: 'stale'; detail: string }
    | { ok: false; reason: 'ambiguous'; detail: string }
    | { ok: false; reason: 'error'; error: string }
  >;
  snapshot: (rootPath: string) => {
    participants: Array<{ agentId: string; label: string; isUser: boolean }>;
    leases: TeamLeaseInfo[];
  };
};

/** Minimal lease shape surfaced to the agent (who holds what). */
export type TeamLeaseInfo = { relPath: string; agentId: string; intent?: string; expiresAt: number };

/** The subset of the Database service the agent tools need. */
export type DbAgentService = {
  listConnections: (
    rootPath?: string
  ) => Promise<Array<{ config: { id: string; name: string; kind: string; readOnly?: boolean } }>>;
  connect: (id: string) => Promise<void>;
  listTables: (id: string) => Promise<Array<{ schema?: string; name: string; type: string; rowCount?: number }>>;
  getColumns: (
    id: string,
    table: string,
    schema?: string
  ) => Promise<Array<{ name: string; type: string; nullable: boolean; primaryKey: boolean }>>;
  getTableDetail: (
    id: string,
    table: string,
    schema?: string
  ) => Promise<{
    columns: Array<{ name: string; type: string; nullable: boolean; primaryKey: boolean }>;
    indexes: Array<{ name: string; columns: string[]; unique: boolean; primary?: boolean }>;
    foreignKeys: Array<{
      name: string;
      columns: string[];
      referencedTable: string;
      referencedSchema?: string;
      referencedColumns: string[];
    }>;
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
  profileTable: (
    id: string,
    table: string,
    schema?: string,
    options?: { sampleLimit?: number; topValues?: number }
  ) => Promise<{
    schema?: string;
    table: string;
    rowCount: number;
    sampled: boolean;
    columns: Array<{
      column: string;
      type: string;
      total: number;
      nulls: number;
      distinct: number;
      min?: number | null;
      max?: number | null;
      avg?: number | null;
      sampled: boolean;
      topValues: Array<{ value: string | number | boolean | null; count: number }>;
    }>;
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

/**
 * Automatic output "headroom" — the central context safety valve.
 *
 * Every IDE tool result flows through {@link guard}, so capping HERE means no
 * tool can flood the agent's context window with an unbounded dump, and the
 * agent never has to REMEMBER to call `ide_compact` by hand. Inspired by the
 * Headroom project: keep the signal, drop the bulk.
 *
 * The cap is deliberately generous (a normal file/search/listing passes through
 * untouched) and acts only as a backstop for pathological output. When a result
 * exceeds {@link HEADROOM_MAX_LINES} we keep a HEAD + TAIL window — the tail
 * matters because build/test logs and stack traces put the verdict last — and
 * splice in a one-line marker telling the agent how to retrieve the omitted
 * middle (a precise `from`/`to` read, `all: true`, or `ide_compact`).
 *
 * A tool that has ALREADY bounded its own output (e.g. `ide_read_file` with an
 * explicit `from`/`to`/`all`, where the user/agent asked for an exact window)
 * opts out by passing `bounded: true`, so deliberate full reads are never
 * second-guessed.
 */
const HEADROOM_MAX_LINES = 2000;
const HEADROOM_HEAD_LINES = 1400;
const HEADROOM_TAIL_LINES = 400;

const applyHeadroom = (text: string): string => {
  const lines = text.split('\n');
  if (lines.length <= HEADROOM_MAX_LINES) return text;
  const head = lines.slice(0, HEADROOM_HEAD_LINES);
  const tail = lines.slice(lines.length - HEADROOM_TAIL_LINES);
  const omitted = lines.length - head.length - tail.length;
  const marker = `… [headroom: ${omitted} of ${lines.length} lines omitted to protect context — re-run with a narrower from/to range, all: true, or pipe the raw output through ide_compact for the full picture] …`;
  return [...head, marker, ...tail].join('\n');
};

/**
 * Run a service call and project its result (or error) onto an MCP payload.
 *
 * `bounded` skips {@link applyHeadroom} for callers that have already produced a
 * deliberately-sized result (explicit-range reads, structured single-row
 * lookups), so an intentional full read is returned verbatim.
 */
const guard = async (
  fn: () => Promise<string>,
  opts?: { bounded?: boolean }
): Promise<ReturnType<typeof textResult>> => {
  try {
    const raw = await fn();
    return textResult(opts?.bounded ? raw : applyHeadroom(raw));
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
};

/** Render one team-edit lease as a compact, agent-friendly line. */
const renderLease = (lease: TeamLeaseInfo): string =>
  `${lease.relPath} — held by ${lease.agentId}${lease.intent ? ` (${lease.intent})` : ''}`;

/** Render a list of grep hits as a compact, agent-friendly text block. */
const renderSearchHits = (hits: IdeSearchHit[]): string => {
  if (hits.length === 0) return 'No matches found.';
  return [
    `${hits.length} match(es):`,
    ...hits.map((h) => `${h.file}:${h.line}${h.column ? `:${h.column}` : ''}: ${h.text}`),
  ].join('\n');
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

const renderTerminalResult = (result: TerminalRunResult, maxBytes?: number): string => {
  const cap = maxBytes && maxBytes > 0 ? maxBytes : 20_000;
  const clip = (value: string): string => (value.length > cap ? `${value.slice(0, cap)}\n...[truncated]` : value);
  return JSON.stringify(
    {
      ...result,
      stdout: clip(result.stdout),
      stderr: clip(result.stderr),
    },
    null,
    2
  );
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

  // ── Optional tool-call guard (Omni External MCP Gateway only) ────────────
  // When the gateway injects a guard, we monkey-patch `server.tool` ONCE so
  // every subsequent registration is transparently wrapped: the guard runs
  // before the real handler, and a denial short-circuits with an MCP
  // `isError:true` result. Internal callers (omitting `toolGuard`) see no
  // behavioural change at all. The wrapper also auto-adds an optional
  // `sessionId` field to the zod schema when the tool does not already
  // declare one, so an external host can echo the session id back.
  if (deps.toolGuard) {
    const guardFn = deps.toolGuard;
    type ToolHandler = (args: Record<string, unknown>) => unknown;
    type ToolRegistrar = (
      name: string,
      description: string,
      schema: Record<string, z.ZodTypeAny>,
      handler: ToolHandler
    ) => unknown;
    const originalTool = (server.tool as unknown as ToolRegistrar).bind(server) as ToolRegistrar;
    const wrappedRegistrar: ToolRegistrar = (name, description, schema, handler) => {
      const augmented: Record<string, z.ZodTypeAny> = { ...schema };
      if (!('sessionId' in schema)) {
        augmented.sessionId = z
          .string()
          .optional()
          .describe('Session id from omni_bootstrap_session (External MCP Gateway only).');
      }
      const wrappedHandler: ToolHandler = async (args) => {
        const verdict = guardFn(name, args);
        if (verdict.allow === false) return textResult(verdict.reason, true);
        return handler(args);
      };
      return originalTool(name, description, augmented, wrappedHandler);
    };
    (server as unknown as { tool: ToolRegistrar }).tool = wrappedRegistrar;
  }

  // --- ide_list_dir --------------------------------------------------------
  server.tool(
    'ide_list_dir',
    `List directory entries on disk. By default lists ONE level (directories first, then files). With a
glob pattern and/or recursive flag it walks subdirectories and filters by pattern — the full power of
the classic "glob" file-finder, but routed through the IDE.

Input:
- dir: absolute path of the folder to list (required)
- glob: optional glob pattern (e.g. "*.ts", "**/*.test.ts", "src/**"). Patterns with no "/" match the basename.
- recursive: optional boolean — walk all subdirectories (skips node_modules/.git/dist/etc.)
- maxResults: optional cap (default 100, max 2000). Recursive results are sorted newest-first.`,
    {
      dir: z.string().describe('Absolute path of the folder to list.'),
      glob: z.string().optional().describe('Glob pattern, e.g. "*.ts" or "**/*.test.ts".'),
      recursive: z.boolean().optional().describe('Walk all subdirectories.'),
      maxResults: z.number().optional().describe('Cap on entries returned (default 100).'),
    },
    ({ dir, glob, recursive, maxResults }) =>
      guard(async () => {
        const entries = await ide.listDir(dir, { glob, recursive, maxResults });
        if (entries.length === 0) return 'No matching entries.';
        return entries
          .map(
            (e) =>
              `${e.isDir ? '[dir] ' : '      '}${e.relativePath ?? e.name}${e.sizeBytes !== undefined ? ` (${e.sizeBytes}b)` : ''}`
          )
          .join('\n');
      })
  );

  // --- ide_glob ------------------------------------------------------------
  server.tool(
    'ide_glob',
    `Find files by glob pattern across a folder tree — the IDE-routed replacement for shell \`find\` /
\`ls **\`. Walks subdirectories by default (skips node_modules/.git/dist/etc.) and returns matching
paths only, so it is cheaper on tokens and CANNOT hang the way a raw recursive \`find\` can. This is a
thin alias over ide_list_dir tuned for "find files matching X": prefer it over ide_command + find.

Input:
- dir: absolute path of the folder to search (required)
- pattern: glob pattern (e.g. "**/*.ts", "src/**/*.test.ts", "*.json"). Patterns with no "/" match the basename.
- recursive: walk subdirectories (default true — pass false to list one level only)
- maxResults: optional cap (default 100, max 2000), sorted newest-first.`,
    {
      dir: z.string().describe('Absolute path of the folder to search.'),
      pattern: z.string().describe('Glob pattern, e.g. "**/*.ts" or "src/**/*.test.ts".'),
      recursive: z.boolean().optional().describe('Walk all subdirectories (default true).'),
      maxResults: z.number().optional().describe('Cap on entries returned (default 100).'),
    },
    ({ dir, pattern, recursive, maxResults }) =>
      guard(async () => {
        const entries = await ide.listDir(dir, { glob: pattern, recursive: recursive ?? true, maxResults });
        const files = entries.filter((e) => !e.isDir);
        if (files.length === 0) return 'No files match the pattern.';
        return files.map((e) => e.relativePath ?? e.fullPath ?? e.name).join('\n');
      })
  );

  // --- ide_read_file -------------------------------------------------------
  server.tool(
    'ide_read_file',
    `Read a file's text content with line numbers. Full parity with a classic "Read" tool PLUS routing
through MTUI: line-range slicing, full-file reads, binary detection, and truncation metadata.

By default returns up to 2000 line-numbered lines. To read a WHOLE large file with NO truncation,
pass all=true. To read a specific window, pass from/to (1-based, inclusive).

Input:
- filePath: absolute path of the file (required)
- all: set true to return the ENTIRE file with no line/byte cap (use this instead of fighting truncation)
- from / to: 1-based inclusive line range
- maxLines: cap on lines (default 2000; ignored when all=true)
- maxBytes: cap on characters (ignored when all=true)
- lineNumbers: prefix each line with "N: " (default true).`,
    {
      filePath: z.string().describe('Absolute path of the file to read.'),
      all: z.boolean().optional().describe('Return the entire file with no truncation.'),
      from: z.number().optional().describe('Start line (1-based, inclusive).'),
      to: z.number().optional().describe('End line (1-based, inclusive).'),
      maxLines: z.number().optional().describe('Cap on returned lines (default 2000).'),
      maxBytes: z.number().optional().describe('Cap on returned characters.'),
      lineNumbers: z.boolean().optional().describe('Prefix each line with its line number (default true).'),
    },
    ({ filePath, all, from, to, maxLines, maxBytes, lineNumbers }) =>
      guard(
        async () => {
          const r = await ide.readFile(filePath, { all, from, to, maxLines, maxBytes, lineNumbers });
          if (r.binary) return r.text;
          const header = `[lines ${r.lineStart}-${r.lineEnd} of ${r.totalLines}${r.truncated ? '; TRUNCATED — pass all=true or a from/to range for more' : ''}]`;
          return `${header}\n${r.text}`;
        },
        // A deliberate window (explicit range or all=true) is returned verbatim;
        // the readFile slicer has already bounded it, so headroom must not re-cut it.
        { bounded: all === true || from !== undefined || to !== undefined }
      )
  );

  // --- ide_search ----------------------------------------------------------
  server.tool(
    'ide_search',
    `Search (grep) across a repository for a query. Literal by default; enable regex / whole-word /
case-sensitive via options. Restrict to specific files with a glob. Returns "file:line:col: text".

Input:
- rootPath: absolute path of the repo/folder to search (required)
- query: the text or pattern to find (required)
- glob: optional glob to restrict files (e.g. "*.ts", "**/*.vue")
- regex / wholeWord / caseSensitive: optional booleans
- maxResults: optional cap on the number of matches (default 200).`,
    {
      rootPath: z.string().describe('Absolute path of the repo/folder to search.'),
      query: z.string().describe('Text or pattern to find.'),
      glob: z.string().optional().describe('Glob pattern restricting which files are searched.'),
      regex: z.boolean().optional().describe('Treat the query as a regular expression.'),
      wholeWord: z.boolean().optional().describe('Match whole words only.'),
      caseSensitive: z.boolean().optional().describe('Case-sensitive match.'),
      maxResults: z.number().optional().describe('Cap on the number of matches (default 200).'),
    },
    ({ rootPath, query, glob, regex, wholeWord, caseSensitive, maxResults }) =>
      guard(async () =>
        renderSearchHits(await ide.search(rootPath, query, { glob, regex, wholeWord, caseSensitive, maxResults }))
      )
  );

  // --- ide_grep ------------------------------------------------------------
  server.tool(
    'ide_grep',
    `Grep file CONTENTS across a repo — the IDE-routed replacement for shell \`grep\` / \`rg\`. Identical
engine to ide_search (literal by default; regex / whole-word / case-sensitive / glob-scoped), exposed
under the familiar "grep" name and tuned to be cheap on tokens (results pass through the headroom cap
so a huge match set never floods context) and unhangable. Prefer it over ide_command + grep/rg.

Input:
- rootPath: absolute path of the repo/folder to search (required)
- pattern: the text or regex to find (required)
- glob: optional glob to restrict files (e.g. "*.ts", "**/*.vue")
- regex / wholeWord / caseSensitive: optional booleans
- maxResults: optional cap on the number of matches (default 200).`,
    {
      rootPath: z.string().describe('Absolute path of the repo/folder to search.'),
      pattern: z.string().describe('Text or regex to find.'),
      glob: z.string().optional().describe('Glob pattern restricting which files are searched.'),
      regex: z.boolean().optional().describe('Treat the pattern as a regular expression.'),
      wholeWord: z.boolean().optional().describe('Match whole words only.'),
      caseSensitive: z.boolean().optional().describe('Case-sensitive match.'),
      maxResults: z.number().optional().describe('Cap on the number of matches (default 200).'),
    },
    ({ rootPath, pattern, glob, regex, wholeWord, caseSensitive, maxResults }) =>
      guard(async () =>
        renderSearchHits(await ide.search(rootPath, pattern, { glob, regex, wholeWord, caseSensitive, maxResults }))
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

  // --- ide_summary ---------------------------------------------------------
  server.tool(
    'ide_summary',
    `Get a CONCISE semantic summary of one file or folder from MTUI's Understand/codegraph: its role,
layer, key symbols, and what imports it. This is the fastest way to understand WHAT a file/folder
does WITHOUT reading the whole thing. Falls back to a filesystem scan when the graph is not built.

Use this FIRST when you land in an unfamiliar file — read the summary, then ide_read_file only the
parts you need.

Input:
- rootPath: absolute repo root (required)
- target: file or folder path relative to the repo root (required; use "." for the whole project)
- kind: "file" or "folder" (default "file").`,
    {
      rootPath: z.string().describe('Absolute repo root.'),
      target: z.string().describe('File or folder path relative to the repo root ("." = whole project).'),
      kind: z.enum(['file', 'folder']).optional().describe('Target kind (default "file").'),
    },
    ({ rootPath, target, kind }) =>
      guard(async () => {
        const r = await ide.understand(rootPath, target, kind ?? 'file', false);
        return `${r.stale ? '[stale — rebuild Understand for fresh data]\n' : ''}${r.summary}`;
      })
  );

  // --- ide_info ------------------------------------------------------------
  server.tool(
    'ide_info',
    `Get the DETAILED Understand/codegraph record for one file or folder: full symbol list (with line
numbers), tags, layer, import relationships, and per-file breakdowns for folders. Heavier than
ide_summary — use it when you need the structure of a file (its functions/classes and where they are)
before editing.

Input:
- rootPath: absolute repo root (required)
- target: file or folder path relative to the repo root (required)
- kind: "file" or "folder" (default "file").`,
    {
      rootPath: z.string().describe('Absolute repo root.'),
      target: z.string().describe('File or folder path relative to the repo root.'),
      kind: z.enum(['file', 'folder']).optional().describe('Target kind (default "file").'),
    },
    ({ rootPath, target, kind }) =>
      guard(async () => {
        const r = await ide.understand(rootPath, target, kind ?? 'file', true);
        return JSON.stringify({ summary: r.summary, stale: r.stale, details: r.details }, null, 2);
      })
  );

  // --- ide_compass ---------------------------------------------------------
  server.tool(
    'ide_compass',
    `Read a code-aware COMPRESSED slice of a file, focused by your intent. Instead of dumping the whole
file, MTUI keeps the structure (imports, signatures) and the regions most relevant to your query,
and tells you where to read next. Ideal for large files when you only care about one concern.

Input:
- rootPath: absolute repo root (required)
- filePath: file path relative to the repo root (required)
- query: natural-language intent describing what you're looking for (optional but recommended)
- maxLines: cap on returned lines (optional).`,
    {
      rootPath: z.string().describe('Absolute repo root.'),
      filePath: z.string().describe('File path relative to the repo root.'),
      query: z.string().optional().describe('What you are looking for, in natural language.'),
      maxLines: z.number().optional().describe('Cap on returned lines.'),
    },
    ({ rootPath, filePath, query, maxLines }) =>
      guard(async () => {
        const r = await ide.compassRead(rootPath, filePath, query, maxLines);
        return r.summary;
      })
  );

  // --- ide_context ---------------------------------------------------------
  server.tool(
    'ide_context',
    `Find the files MOST RELEVANT to a natural-language intent, ranked by MTUI's Understand graph. Given
a task like "where is auth handled" you get back a ranked list of candidate files with a one-line
reason + summary each, so you know what to open first WITHOUT grepping blindly.

Use this at the START of a task to locate the right files fast.

Input:
- rootPath: absolute repo root (required)
- intent: natural-language description of the task / concern (required)
- limit: max candidates to return (optional, default 10).`,
    {
      rootPath: z.string().describe('Absolute repo root.'),
      intent: z.string().describe('Natural-language task or concern.'),
      limit: z.number().optional().describe('Max candidates (default 10).'),
    },
    ({ rootPath, intent, limit }) =>
      guard(async () => {
        const r = await ide.context(rootPath, intent, limit);
        return r.summary;
      })
  );

  // --- ide_map -------------------------------------------------------------
  server.tool(
    'ide_map',
    `Get a navigable MAP of the codebase from MTUI's Understand graph: top-level modules, their layers,
key files ranked by read-priority, and a recommended reading path. Use this to orient yourself in a
new repo or a large folder before diving in.

Input:
- rootPath: absolute repo root (required)
- scope: "repo" (whole project), "folder" (one folder), or "intent" (task-focused) (default "repo")
- target: folder path (for scope=folder) or intent text (for scope=intent)
- limit: max entries (optional).`,
    {
      rootPath: z.string().describe('Absolute repo root.'),
      scope: z.enum(['repo', 'folder', 'intent']).optional().describe('Map scope (default "repo").'),
      target: z.string().optional().describe('Folder path or intent text, depending on scope.'),
      limit: z.number().optional().describe('Max entries.'),
    },
    ({ rootPath, scope, target, limit }) =>
      guard(async () => {
        const r = await ide.map(rootPath, scope ?? 'repo', target, limit);
        return JSON.stringify({ summary: r.summary, stale: r.stale, details: r.details }, null, 2);
      })
  );

  // --- ide_analyze ---------------------------------------------------------
  server.tool(
    'ide_analyze',
    `Analyze the codebase with MTUI: detect languages + editor engines, or error-check a path. Run with
no target to get a language/engine overview; pass a target path to error-check that file/folder.

Input:
- rootPath: absolute repo root (required)
- target: optional file/folder path to error-check (omit for a language overview).`,
    {
      rootPath: z.string().describe('Absolute repo root.'),
      target: z.string().optional().describe('Optional path to error-check (omit for a language overview).'),
    },
    ({ rootPath, target }) =>
      guard(async () => {
        const r = await ide.analyze(rootPath, target);
        return JSON.stringify({ summary: r.summary, details: r.details }, null, 2);
      })
  );

  // --- ide_compact ---------------------------------------------------------
  server.tool(
    'ide_compact',
    `Compress a noisy build/test log down to the lines that matter (errors, warnings, failures, diffs)
using MTUI's compactor. Paste a long log and get back a focused excerpt, so you don't burn context on
thousands of "Compiling…" lines. Auto-detects the toolchain (vitest / tsc / cargo / pytest).

Input:
- rootPath: absolute repo root (required)
- input: the raw log/output text to compact (required)
- profile: optional toolchain hint ("vitest" | "tsc" | "cargo" | "pytest")
- maxLines: optional cap on output lines.`,
    {
      rootPath: z.string().describe('Absolute repo root.'),
      input: z.string().describe('Raw log/output text to compact.'),
      profile: z.string().optional().describe('Toolchain hint (vitest/tsc/cargo/pytest).'),
      maxLines: z.number().optional().describe('Cap on output lines.'),
    },
    ({ rootPath, input, profile, maxLines }) =>
      guard(async () => {
        const r = await ide.compact(rootPath, input, profile, maxLines);
        return r.summary;
      })
  );

  // --- ide_command ---------------------------------------------------------
  server.tool(
    'ide_command',
    `Run an ARBITRARY shell command under guard rails — the sanctioned escape hatch for work no
dedicated tool models (npm/bun install, build scripts, git, a one-off command). Prefer the structured
tools first: ide_search (grep), ide_list_dir (find/ls), ide_read_file (cat). Reach for ide_command
only when none of those fit.

Unlike a raw shell this CANNOT hang your session and CANNOT flood your context: every run has a hard
timeout, interactive prompts are disabled (a command waiting for input fails fast), and output is
byte/line capped (pipe a long log through ide_compact for the meaningful lines).

There is no persistent working directory: instead of \`cd abc && x\`, pass cwd="<root>/abc" and
command="x". The command string still runs through a shell, so pipes, &&, and globs work.

Input:
- rootPath: absolute repo root (required; also the default working directory)
- command: the command line to run (required)
- cwd: working directory for THIS run (optional; defaults to rootPath)
- timeoutMs: hard timeout before the command is killed (optional; default 60000).`,
    {
      rootPath: z.string().describe('Absolute repo root (also the default working directory).'),
      command: z.string().describe('The command line to run (pipes / && / globs allowed).'),
      cwd: z.string().optional().describe('Working directory for this run (defaults to rootPath).'),
      timeoutMs: z.number().optional().describe('Hard timeout in ms before the command is killed (default 60000).'),
    },
    ({ rootPath, command, cwd, timeoutMs }) =>
      guard(async () => {
        const r = await ide.runCommand(rootPath, command, { cwd, timeoutMs });
        const status = r.timedOut
          ? `TIMED OUT after ${r.durationMs}ms (killed)`
          : `exit ${r.code} in ${r.durationMs}ms`;
        const parts = [`[${status}]`];
        if (r.stdout.trim().length > 0) parts.push(`--- stdout ---\n${r.stdout.trimEnd()}`);
        if (r.stderr.trim().length > 0) parts.push(`--- stderr ---\n${r.stderr.trimEnd()}`);
        if (r.stdout.trim().length === 0 && r.stderr.trim().length === 0) parts.push('(no output)');
        return parts.join('\n');
      })
  );
  // --- terminal_run --------------------------------------------------------
  if (deps.terminal) {
    const terminal = deps.terminal;
    server.tool(
      'terminal_run',
      `Run one local command for rescue/debugging. Commands are executed without a shell by default; pass
PowerShell, cmd, bash, or another shell explicitly when shell behavior is required.

Input:
- command: executable to run (required)
- args: optional argument array
- cwd: optional working directory; defaults to sidecar working directory
- timeoutMs: optional timeout, capped by the sidecar implementation.`,
      {
        command: z.string().describe('Executable to run.'),
        args: z.array(z.string()).optional().describe('Arguments passed to the executable.'),
        cwd: z.string().optional().describe('Working directory.'),
        timeoutMs: z.number().optional().describe('Timeout in milliseconds.'),
        maxBytes: z.number().optional().describe('Maximum stdout/stderr bytes returned per stream.'),
      },
      ({ command, args, cwd, timeoutMs, maxBytes }) =>
        guard(async () => renderTerminalResult(await terminal.run(command, args, { cwd, timeoutMs }), maxBytes))
    );
  }

  // --- git_* ---------------------------------------------------------------
  if (deps.git) {
    const git = deps.git;
    server.tool(
      'git_status',
      `Show the repository status using git status --short --branch.

Input:
- rootPath: absolute path of the Git repository (required).`,
      { rootPath: z.string().describe('Absolute path of the Git repository.') },
      ({ rootPath }) => guard(async () => renderTerminalResult(await git.status(rootPath)))
    );

    server.tool(
      'git_diff',
      `Show a Git diff for rescue inspection.

Input:
- rootPath: absolute path of the Git repository (required)
- staged: when true, show staged diff
- path: optional pathspec
- maxBytes: optional output cap per stream.`,
      {
        rootPath: z.string().describe('Absolute path of the Git repository.'),
        staged: z.boolean().optional().describe('Show staged diff.'),
        path: z.string().optional().describe('Optional pathspec.'),
        maxBytes: z.number().optional().describe('Maximum stdout/stderr bytes returned per stream.'),
      },
      ({ rootPath, staged, path, maxBytes }) =>
        guard(async () => renderTerminalResult(await git.diff(rootPath, { staged, path, maxBytes }), maxBytes))
    );

    server.tool(
      'git_log',
      `Show recent Git commits for orientation.

Input:
- rootPath: absolute path of the Git repository (required)
- maxCount: optional number of commits, default 10.`,
      {
        rootPath: z.string().describe('Absolute path of the Git repository.'),
        maxCount: z.number().optional().describe('Number of commits to show.'),
      },
      ({ rootPath, maxCount }) => guard(async () => renderTerminalResult(await git.log(rootPath, maxCount)))
    );
  }

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
            conns.map((c) => ({
              id: c.config.id,
              name: c.config.name,
              kind: c.config.kind,
              readOnly: c.config.readOnly !== false,
            })),
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
          return tables
            .map((t) => `${t.type === 'view' ? '[view] ' : ''}${t.schema ? `${t.schema}.` : ''}${t.name}`)
            .join('\n');
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
            ...detail.columns.map(
              (c) => `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.primaryKey ? ' PK' : ''}`
            )
          );
          if (detail.indexes.length > 0) {
            lines.push('', '## Indexes');
            lines.push(
              ...detail.indexes.map(
                (ix) =>
                  `${ix.name} (${ix.columns.join(', ')})${ix.unique ? ' UNIQUE' : ''}${ix.primary ? ' PRIMARY' : ''}`
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
        params: z
          .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional()
          .describe('Positional bound parameters.'),
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

    server.tool(
      'db_profile_table',
      `Statistically profile a table WITHOUT writing aggregate SQL by hand: for each column you get the
fill rate (non-null %), distinct count, numeric min/avg/max, and the top frequent values for
low-cardinality columns — the fast answer to "what's actually in this table?". Read-only + bounded
to a sample on huge tables, so it is always safe to run.

Input:
- id: connection id (required)
- table: table name (required)
- schema: optional schema/owner (postgres).`,
      {
        id: z.string().describe('Connection id.'),
        table: z.string().describe('Table name to profile.'),
        schema: z.string().optional().describe('Schema/owner (postgres).'),
      },
      ({ id, table, schema }) =>
        guard(async () => {
          await db.connect(id);
          const profile = await db.profileTable(id, table, schema);
          return JSON.stringify(
            {
              table: profile.table,
              schema: profile.schema,
              rowCount: profile.rowCount,
              sampled: profile.sampled,
              columns: profile.columns.map((c) =>
                Object.assign(
                  {
                    column: c.column,
                    type: c.type,
                    fillRate: c.total > 0 ? Math.round(((c.total - c.nulls) / c.total) * 100) / 100 : 0,
                    nulls: c.nulls,
                    distinct: c.distinct,
                  },
                  c.min !== undefined || c.max !== undefined || c.avg !== undefined
                    ? { min: c.min, avg: c.avg, max: c.max }
                    : {},
                  c.topValues.length > 0 ? { topValues: c.topValues } : {}
                )
              ),
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
            result.truncated
              ? 'Note was long and got truncated — keep notes short (the repo map already holds file contents).'
              : '',
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
            recall.secretKeys.length > 0
              ? `## Secret keys available\n${recall.secretKeys.map((k) => `- ${k}`).join('\n')}`
              : '',
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

  // --- team_* (Agent Team Edit — Agent plane) ------------------------------
  // Only exposed when a Team Edit coordinator is injected (production wiring).
  if (deps.teamEdit) {
    const team = deps.teamEdit;

    server.tool(
      'team_claim_file',
      `Claim an ADVISORY lease on a file before you edit it, so other agents working the same workspace
don't overwrite your changes. Always claim a file before writing it with team_write_file. If another
agent already holds it you get a conflict naming the holder — coordinate or pick a different file
instead of clobbering their work. The lease auto-expires, so claim again (or just team_write_file,
which renews it) if you take a while.

Input:
- rootPath: absolute workspace root (required)
- agentId: YOUR stable id in this session (required — use your session memory id or role id)
- relPath: workspace-relative path of the file to claim (required)
- intent: short note on what you're about to do (optional, shown to teammates).`,
      {
        rootPath: z.string().describe('Absolute workspace root.'),
        agentId: z.string().describe('Your stable participant id for this session.'),
        relPath: z.string().describe('Workspace-relative path of the file to claim.'),
        intent: z.string().optional().describe('Short note on what you are about to do.'),
      },
      ({ rootPath, agentId, relPath, intent }) =>
        guard(async () => {
          const result = team.claim(rootPath, agentId, relPath, intent);
          if (result.ok) {
            return `Claimed ${result.lease.relPath}${result.renewed ? ' (renewed your existing lease)' : ''}. You may edit it now; call team_release_file when done.`;
          }
          return `CONFLICT: ${renderLease(result.lease)}. Do NOT edit it — coordinate with that agent or pick a different file.`;
        })
    );

    server.tool(
      'team_write_file',
      `Write a file ON BEHALF of you, guarded by the team lease: if another agent holds the file the write
is REFUSED (you get the holder back) instead of overwriting their work; otherwise your lease is
auto-acquired/renewed and the bytes are written through the MTUI gateway (so the edit is backed-up and
undoable, exactly like the IDE's own writes). This is the correct way to edit a file when several
agents share a workspace — prefer it over a raw filesystem write.

Input:
- rootPath: absolute workspace root (required)
- agentId: YOUR stable participant id (required)
- relPath: workspace-relative path of the file to write (required)
- content: the FULL new file content (required — this replaces the whole file).`,
      {
        rootPath: z.string().describe('Absolute workspace root.'),
        agentId: z.string().describe('Your stable participant id for this session.'),
        relPath: z.string().describe('Workspace-relative path of the file to write.'),
        content: z.string().describe('The full new file content (replaces the whole file).'),
      },
      ({ rootPath, agentId, relPath, content }) =>
        guard(async () => {
          const result = await team.write(rootPath, agentId, relPath, content);
          if (result.ok === true) return `Wrote ${relPath} (${result.bytes} bytes) via MTUI.`;
          if (result.reason === 'held') {
            return `CONFLICT: ${renderLease(result.lease)}. The write was REFUSED so you don't clobber that agent. Coordinate or edit a different file.`;
          }
          return `Write failed: ${result.error}`;
        })
    );

    server.tool(
      'team_edit_file',
      `COLLABORATIVELY edit a file by replacing an EXACT anchor of text — the SAFE way for several agents
to work the SAME file at once. Unlike team_write_file (which replaces the whole file), this changes
only the region you name, so two agents editing DIFFERENT parts of one file BOTH succeed: MTUI merges
non-overlapping edits. Prefer this over team_write_file whenever you only need to change part of a file.

How it protects you:
- If "oldText" no longer matches (someone changed that region since you read it) you get STALE — do NOT
  retry blindly: re-read the file (e.g. ide_read_file), rebase your change on the new content, and edit
  again. This is what stops you clobbering a teammate's work.
- If "oldText" matches MORE than one place you get AMBIGUOUS — pass a longer, unique anchor (include
  surrounding lines) so exactly one location matches.
- If another agent holds the file's lease you get a conflict naming the holder.

Input:
- rootPath: absolute workspace root (required)
- agentId: YOUR stable participant id (required)
- relPath: workspace-relative path of the file to edit (required)
- oldText: the EXACT current text to replace — must match exactly once (required)
- newText: the replacement text (required).`,
      {
        rootPath: z.string().describe('Absolute workspace root.'),
        agentId: z.string().describe('Your stable participant id for this session.'),
        relPath: z.string().describe('Workspace-relative path of the file to edit.'),
        oldText: z.string().describe('Exact current text to replace (the anchor); must match exactly once.'),
        newText: z.string().describe('Replacement text.'),
      },
      ({ rootPath, agentId, relPath, oldText, newText }) =>
        guard(async () => {
          const result = await team.editReplace(rootPath, agentId, relPath, oldText, newText);
          if (result.ok === true) return `Edited ${relPath} (${result.matches} match replaced) via MTUI.`;
          if (result.reason === 'held') {
            return `CONFLICT: ${renderLease(result.lease)}. The edit was REFUSED so you don't clobber that agent. Coordinate or edit a different file.`;
          }
          if (result.reason === 'stale') {
            return `STALE: ${result.detail}\nThe anchor no longer matches (someone changed that region). Re-read the file with ide_read_file, rebase your edit on the new content, then try again — do NOT force it.`;
          }
          if (result.reason === 'ambiguous') {
            return `AMBIGUOUS: ${result.detail}\nYour "oldText" matches more than one place. Use a longer, unique anchor (include surrounding lines).`;
          }
          return `Edit failed: ${result.error}`;
        })
    );

    server.tool(
      'team_release_file',
      `Release the advisory lease you hold on a file once you've finished editing it, so another agent can
take it. No-op if you don't hold it. Releasing promptly keeps the team moving (mirrors the
"finish then hand off" model).

Input:
- rootPath: absolute workspace root (required)
- agentId: YOUR stable participant id (required)
- relPath: workspace-relative path of the file to release (required).`,
      {
        rootPath: z.string().describe('Absolute workspace root.'),
        agentId: z.string().describe('Your stable participant id for this session.'),
        relPath: z.string().describe('Workspace-relative path of the file to release.'),
      },
      ({ rootPath, agentId, relPath }) =>
        guard(async () =>
          team.release(rootPath, agentId, relPath) ? `Released ${relPath}.` : `You did not hold a lease on ${relPath}.`
        )
    );

    server.tool(
      'team_status',
      `See who else is working in this workspace and which files they currently hold, so you can divide
work by file and avoid conflicts. Call this before claiming a batch of files.

Input:
- rootPath: absolute workspace root (required).`,
      { rootPath: z.string().describe('Absolute workspace root.') },
      ({ rootPath }) =>
        guard(async () => {
          const snap = team.snapshot(rootPath);
          const people =
            snap.participants.length > 0
              ? snap.participants.map((p) => `- ${p.label}${p.isUser ? ' (user)' : ''} [${p.agentId}]`).join('\n')
              : '- (nobody yet)';
          const held =
            snap.leases.length > 0 ? snap.leases.map((l) => `- ${renderLease(l)}`).join('\n') : '- (no files held)';
          return [`## Participants`, people, '', `## Held files`, held].join('\n');
        })
    );
  }

  return server;
};
