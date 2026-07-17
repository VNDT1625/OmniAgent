/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Workspace primer — the markdown block injected at the start of an IDE chat
 * session (and now also returned by the Omni External MCP Gateway's
 * `omni_bootstrap_session` tool). Pure string builder, no Node APIs, so the
 * renderer can import it as well.
 *
 * Process boundary: shared (Main + Renderer). No fs/DOM access here — callers
 * load rules via `loadProjectRules` (Main) or `ideClient.rulesLoad` (Renderer)
 * and pass the result in.
 */

/** Body of the "## Session memory" rules block, bound to the given sessionId. */
export const buildIdeMemorySection = (sessionId: string): string =>
  [
    '## Session memory (your ephemeral scratchpad)',
    '',
    `Your session memory id is: ${sessionId}`,
    'Pass this exact id as `sessionId` to every `ide_memory_*` tool.',
    '',
    'This memory exists ONLY while this chat tab is open and is wiped when it closes. Use it for the few',
    'things you must remember across turns so you do NOT re-search the repo every time:',
    '- `ide_memory_remember` — jot a short fact / decision / todo (do NOT paste large file contents;',
    '  the repo map / MTUI already holds those). Pin only truly critical facts.',
    '- `ide_memory_recall` — read your notes back at the START of a turn before re-searching the code.',
    '- `ide_memory_set_secret` / (read via context) — stash a short-lived secret (e.g. an API key the',
    '  user gave you for THIS session only). It stays in RAM, is never written to disk, and is wiped on',
    '  close.',
    '- `ide_memory_status` — check how full the memory is; `ide_memory_forget` — drop a stale note.',
    '- `ide_secret_context_list` — inspect repository secret aliases only when a task needs credentials.',
    '  Values are opaque: use their environment-variable alias in code/config. If the local user explicitly asks',
    '  to view an alias, reply exactly as `ALIAS is {{secret:ALIAS}}` (for example `TEST is {{secret:TEST}}`).',
    '  This is a local-render marker that provides Reveal UI; you never receive, print, request, or infer its value.',
    '',
    'The memory auto-summarises older notes when it grows large, so prefer many small notes over one',
    'giant one, and rely on it to keep your working context short.',
  ].join('\n');

/** Idempotently append the session-memory block to an existing rules string. */
export const withIdeMemorySection = (sessionId: string, existingRules?: string): string => {
  const base = (existingRules ?? '').trim();
  if (base.includes('Session memory (your ephemeral scratchpad)')) return base;
  const block = buildIdeMemorySection(sessionId);
  return base.length > 0 ? `${base}\n\n${block}` : block;
};

/** Input for {@link buildWorkspacePrimer}. */
export type BuildWorkspacePrimerInput = {
  /** Absolute path of the workspace folder. */
  rootPath: string;
  /** Project rules lines (from `.aionrules` / `AGENTS.md` / `.cursorrules`). */
  rules: readonly string[];
  /** Whether Planning Mode is on for this workspace. */
  planningEnabled: boolean;
  /** Ephemeral session-memory id to bind to this primer. */
  sessionMemoryId: string;
};

/**
 * Build the IDE workspace primer markdown.
 *
 * Sections always present:
 *   - "## IDE workspace guide"  (root + Strict IDE notice)
 *   - "## Session memory"        (bound to {@link sessionMemoryId})
 *
 * Sections conditional:
 *   - "## Planning Mode: ON"     when {@link planningEnabled}
 *   - "## Project rules"          when {@link rules} is non-empty
 */
export const buildWorkspacePrimer = ({
  rootPath,
  rules,
  planningEnabled,
  sessionMemoryId,
}: BuildWorkspacePrimerInput): string => {
  const sections: string[] = [
    [
      '## IDE workspace guide',
      `Workspace root: ${rootPath}`,
      'Use codegraph/wiki/search as a map; inspect source lazily only when the task needs it.',
      'Strict IDE Mode is enforced by Tomny: native repo tools (Bash, Read, Grep, Glob, Write, Edit, ...) can be rejected through the permission protocol before the backend executes them. This is a core policy denial, not a user decision: never report that the user blocked or denied the task. Retry with the matching neutral tool: Read/cat → `tomny_read`; Grep/rg → `tomny_search`; Glob/find/ls → `tomny_glob`; shell commands → `tomny_command`; partial edits → `tomny_team_edit`; full writes → `tomny_team_write`. Prefer `tomny_context`, `tomny_map`, and `tomny_analyze` before broad reads. The legacy `ide_*` and `team_*` names remain compatibility aliases.',
    ].join('\n'),
  ];
  if (planningEnabled) {
    sections.push(
      [
        '## Planning Mode: ON',
        'Unclear scope: ask first.',
        'Non-trivial task: maintain `.omni/specs/<slug>/`; execute claimed backend tasks with verification.',
      ].join('\n')
    );
  }
  if (rules.length > 0) {
    sections.push('## Project rules\n' + rules.map((rule) => `- ${rule}`).join('\n'));
  }
  return withIdeMemorySection(sessionMemoryId, sections.join('\n\n'));
};
