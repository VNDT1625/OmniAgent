/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The external-host tool allowlist for the IDE profile.
 *
 * Split into two groups so the user can opt in to the dangerous ones from
 * Settings → External MCP Gateway → "Allow dangerous tools" without exposing
 * shell / DB / destructive writes by default. Both groups still go through the
 * same underlying services (via {@link createIdeServer}); the gateway just
 * adds a guard that refuses the dangerous group when the flag is off.
 *
 * Process boundary: shared (pure data — Main + Renderer can import).
 */

/** One tool entry in either allowlist group. */
export type OmniIdeAllowlistEntry = {
  name: string;
  description: string;
};

/**
 * Tools allowed by default for any external host that has bootstrapped a
 * session. Read-only or guarded operations; safe to expose to ChatGPT/Cursor.
 */
export const OMNI_IDE_BASE_ALLOWLIST: readonly OmniIdeAllowlistEntry[] = [
  { name: 'ide_list_dir', description: 'List directory entries on disk.' },
  { name: 'ide_glob', description: 'Find files by glob pattern across a folder tree.' },
  { name: 'ide_read_file', description: "Read a file's text content with line numbers." },
  { name: 'ide_search', description: 'Search (grep) across a repository for a query.' },
  { name: 'ide_grep', description: 'Grep file contents across a repo.' },
  { name: 'ide_find_definition', description: 'Find where a symbol is declared.' },
  { name: 'ide_find_references', description: 'Find all references of an identifier.' },
  { name: 'ide_scan_repo', description: 'Scan a repo into an import-graph summary.' },
  { name: 'ide_summary', description: 'Concise semantic summary of a file/folder.' },
  { name: 'ide_info', description: 'Detailed Understand record for a file/folder.' },
  { name: 'ide_compass', description: 'Code-aware compressed slice of a file.' },
  { name: 'ide_context', description: 'Rank files relevant to a natural-language intent.' },
  { name: 'ide_map', description: 'Navigable map of the codebase.' },
  { name: 'ide_analyze', description: 'Detect languages / error-check a path.' },
  { name: 'ide_compact', description: 'Compress noisy build/test logs.' },
  { name: 'team_claim_file', description: 'Claim an advisory lease before editing.' },
  { name: 'team_edit_file', description: 'Replace an exact anchor of text in a file.' },
  { name: 'team_release_file', description: 'Release a previously claimed lease.' },
  { name: 'team_status', description: 'Who holds which files in the workspace.' },
  { name: 'import_artifact_text', description: 'Import a connector-provided text file as a session artifact.' },
  { name: 'apply_artifact_edit', description: 'Apply an imported text artifact to a workspace file safely.' },
  {
    name: 'import_media_asset',
    description: 'Copy an uploaded image/video artifact into an allowed repo asset folder.',
  },
  { name: 'list_artifacts', description: 'List imported artifacts for the active MCP session.' },
  { name: 'delete_artifact', description: 'Delete a temporary imported artifact from the active MCP session.' },
  { name: 'ide_memory_remember', description: 'Save a short note to ephemeral session memory.' },
  { name: 'ide_memory_recall', description: 'Read back session memory.' },
  { name: 'ide_memory_status', description: 'Session memory usage / counters.' },
  { name: 'ide_quick_test', description: 'Run a bounded Quick Test session and map the trace.' },
];

/**
 * Tools NOT exposed unless the user enables "Allow dangerous tools" in
 * Settings. The threat model for an external AI host (ChatGPT / Cursor / etc.)
 * differs from the internal IDE chat tab — shell execution, full-file writes,
 * arbitrary SQL, and secret storage are gated.
 */
export const OMNI_IDE_DANGEROUS_TOOLS: readonly OmniIdeAllowlistEntry[] = [
  { name: 'ide_command', description: 'Run an arbitrary shell command under guard rails.' },
  { name: 'team_write_file', description: 'Replace the entire content of a file.' },
  { name: 'ide_memory_set_secret', description: 'Store a session-scoped secret in RAM.' },
  { name: 'ide_memory_forget', description: 'Delete a session memory note by id.' },
  { name: 'db_list_connections', description: 'List saved database connections.' },
  { name: 'db_list_tables', description: 'List tables of a connected database.' },
  { name: 'db_describe_table', description: 'Describe one table in full.' },
  { name: 'db_query', description: 'Run a SQL statement against a connection.' },
  { name: 'db_profile_table', description: 'Statistically profile a table.' },
];

/** Set of base-allowed tool names (for quick lookup in the guard). */
export const OMNI_IDE_BASE_ALLOWLIST_NAMES: ReadonlySet<string> = new Set(OMNI_IDE_BASE_ALLOWLIST.map((t) => t.name));

/** Set of dangerous tool names (for quick lookup in the guard). */
export const OMNI_IDE_DANGEROUS_NAMES: ReadonlySet<string> = new Set(OMNI_IDE_DANGEROUS_TOOLS.map((t) => t.name));

/**
 * Subset of the base allowlist that is safe to expose over the **public
 * tunnel** (External Test Mode). Read-only or read-mostly tools only — no
 * shell, no writes, no DB, no secret/memory mutation, even when the user has
 * the "Allow dangerous tools" flag on. The local plane keeps the broader
 * allowlist for first-party clients (Claude Desktop / Cursor).
 */
export const OMNI_IDE_EXTERNAL_ALLOWLIST_NAMES: ReadonlySet<string> = new Set([
  'ide_list_dir',
  'ide_glob',
  'ide_read_file',
  'ide_search',
  'ide_grep',
  'ide_find_definition',
  'ide_find_references',
  'ide_summary',
  'ide_info',
  'ide_compass',
  'ide_context',
  'ide_map',
  'ide_analyze',
  'ide_memory_recall',
  'ide_memory_status',
  'team_status',
]);
