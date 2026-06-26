/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
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
      'Strict IDE Mode is enforced by AionUi: native tools (Bash, Read, Grep, Glob, Write, Edit, ...) are CANCELLED by rejecting the permission (to stop the backend executing them). The system runs the allowed equivalent tool server-side and delivers the real output to you as a completed tool_call (status=completed) for the original call_id. You will also see a chat message like "Đã chuyển từ ... sang `ide_xxx`". Use the output from the completed tool_call as your tool result. Ignore any "User denied the tool request" or generic cancelled status from the permission rejection — it is only policy enforcement.',
    ].join('\n'),
  ];
  if (planningEnabled) {
    sections.push(
      [
        '## Planning Mode: ON',
        'Unclear scope: ask first.',
        'Non-trivial task: maintain `.aionui/specs/<slug>/`; execute claimed backend tasks with verification.',
      ].join('\n')
    );
  }
  if (rules.length > 0) {
    sections.push('## Project rules\n' + rules.map((rule) => `- ${rule}`).join('\n'));
  }
  return withIdeMemorySection(sessionMemoryId, sections.join('\n\n'));
};
