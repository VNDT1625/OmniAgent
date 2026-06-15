/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Standing instructions injected into a conversation's rules layer when **Super**
 * is on (the Browser-Control MCP is attached).
 *
 * Why this exists: without explicit guidance the CLI agent (aionrs / Claude
 * Code, …) tends to "open a browser" by **spawning sub-agents that shell out to
 * the OS** (`start`/`open`/`cmd /c start`). On Windows that fails outright
 * ("Windows cannot find '\\'") and, worse, those sub-agents do not inherit the
 * conversation's Browser-Control tools, so they have no way to actually drive a
 * page. The result is the user-reported "sub-agent has no permission / stuck".
 *
 * These rules steer the agent to the embedded `browser_*` tools instead — which
 * open tabs *inside the app* that the user can watch live — and tell it to run
 * things "in parallel" by opening multiple tabs itself rather than spawning
 * sub-agents or running shell commands.
 *
 * Renderer-only module: a pure string builder, no side effects.
 */

/** Canonical name of the built-in Browser-Control MCP server (mirror constant). */
export const BROWSER_CONTROL_MCP_NAME = 'aionui-browser-control';

/** The Super standing-instructions block appended to a conversation's rules. */
export const SUPER_BROWSER_RULES = [
  '## Super capabilities (Super is ON)',
  '',
  'You can drive the app end-to-end through these embedded tools. Everything you open shows up as a',
  'LIVE FRAME right inside this chat (several frames render side by side), and the user watches it live.',
  '',
  'Browser: `browser_open`, `browser_research`, `browser_list_tabs`, `browser_read_text`,',
  '`browser_click`, `browser_type`, `browser_scroll`, `browser_wait_for`, `browser_screenshot`,',
  '`browser_summarize_video`. Each `browser_open` is its own in-chat browser frame.',
  '',
  'Editor (the Studio editor): `editor_open`, `editor_read`, `editor_write`, `editor_close`,',
  '`editor_list`. `editor_open` shows a file as a live editor frame in the chat; `editor_write`',
  'replaces the whole file and the frame updates live. Use these to show and work on a document/code',
  'file the user should see — a browser frame and an editor frame can run at the same time.',
  '',
  'ALWAYS research before you act:',
  '- Before opening anything, call `browser_research` FIRST (a HIDDEN background search) to find the',
  '  exact URL / information you need. It never disturbs the frames the user is watching.',
  '- THEN call `browser_open` with the resolved URL so you land directly on the right page.',
  '- Use `browser_research` / `editor_read` for fact-finding; use the visible frames',
  '  (`browser_open` / `editor_open`) only for what the user should actually SEE.',
  '',
  'Rules:',
  '- ALWAYS use these `browser_*` / `editor_*` tools. They are the only correct way to act here.',
  '- NEVER spawn sub-agents, and NEVER run shell/OS commands to open a browser or edit files',
  '  (e.g. `start`, `open`, `xdg-open`, `cmd /c start`). Those bypass the in-chat frames the user',
  '  watches, and sub-agents do NOT inherit these tools, so they will fail.',
  '- To do several things at once, open MULTIPLE frames yourself (repeated `browser_open` /',
  '  `editor_open`) — each opens a separate in-chat frame. Use `browser_list_tabs` / `editor_list`',
  '  to see what you have open.',
  '- Each `browser_open` returns a `tabId`. To work on several sites at once (e.g. open Facebook and',
  '  type into it WHILE another tab does something else), pass the matching `tabId` to every',
  '  `browser_click` / `browser_type` / `browser_scroll` / `browser_read_text` call. Interleave the',
  '  steps across tabs — do NOT finish one tab before touching the other; both frames stay live.',
].join('\n');

/**
 * Append the Super browser rules to an existing rules string (idempotent).
 *
 * @param existingRules The conversation's current rules (may be empty/undefined).
 * @returns The combined rules string with the Super block appended once.
 */
export const withSuperBrowserRules = (existingRules?: string): string => {
  const base = (existingRules ?? '').trim();
  if (base.includes('Super capabilities (Super is ON)')) return base; // already present
  return base.length > 0 ? `${base}\n\n${SUPER_BROWSER_RULES}` : SUPER_BROWSER_RULES;
};

/** Canonical name of the built-in IDE MCP server (mirror constant). */
export const IDE_MCP_NAME = 'aionui-ide';

/** Standing instructions appended when the IDE MCP server is attached to a role. */
export const IDE_TOOLS_RULES = [
  '## IDE capabilities (repo intelligence)',
  '',
  'You have IDE / repo-intelligence tools for working on a codebase. Use them instead of guessing or',
  'shelling out:',
  "- `ide_scan_repo` — get a project's shape (file count, import edges, top folders) before diving in.",
  '- `ide_search` — grep across the repo (literal, or regex / whole-word / case-sensitive).',
  '- `ide_find_definition` / `ide_find_references` — jump to where a symbol is declared / used.',
  '- `ide_list_dir` — list any folder on disk; `ide_read_file` — read a file before editing it.',
  '- `ide_quick_test` — run the app and watch what breaks: records a runtime trace (web clicks/network/',
  '  console/exceptions, or android/windows app logs) for a short window and maps the first error to the',
  '  suspected source files. Exercise the app yourself during the window (navigate, tap), then read the',
  '  returned suspected files first when fixing the bug.',
  '- `db_list_connections` / `db_list_tables` / `db_describe_table` / `db_query` — inspect and query the',
  "  open repo's database(s) directly. Read-only connections reject writes; prefer parameterised db_query",
  '  (pass values in "params") over string-concatenated SQL.',
  '',
  'Rules:',
  '- Prefer these `ide_*` tools to understand the code (scan → search → read) before you change',
  '  anything. They reflect the same repo intelligence the IDE workspace uses.',
  '- Use absolute paths. When you need to edit a file, read it first with `ide_read_file`.',
].join('\n');

/**
 * Append the IDE tool rules to an existing rules/briefing string (idempotent).
 *
 * @param existingRules The conversation's current rules/briefing (may be empty).
 * @returns The combined string with the IDE block appended once.
 */
export const withIdeToolRules = (existingRules?: string): string => {
  const base = (existingRules ?? '').trim();
  if (base.includes('IDE capabilities (repo intelligence)')) return base; // already present
  return base.length > 0 ? `${base}\n\n${IDE_TOOLS_RULES}` : IDE_TOOLS_RULES;
};

/** Canonical name of the built-in Realtime Knowledge MCP server (mirror constant). */
export const REALTIME_KNOWLEDGE_MCP_NAME = 'aionui-realtime-knowledge';

/**
 * Standing instructions appended when the Realtime Knowledge MCP server is
 * attached. Teaches the agent to ground time-sensitive answers on RTK and to
 * keep facts current (mechanisms c + d): look up first, verify stale/expired
 * facts with its own tools, then record the verified value back.
 */
export const REALTIME_KNOWLEDGE_TOOLS_RULES = [
  '## Realtime knowledge (avoid stale answers)',
  '',
  'Some facts change over time — software versions, prices, who currently holds a role, evolving API',
  'specs, statistics. Your training data may be out of date for these. Use the Realtime Knowledge tools:',
  '- `rtk_lookup` — BEFORE answering a time-sensitive question, look it up. Each result carries a',
  '  freshness (fresh / stale / expired), the date it was valid (validAsOf) and its sources.',
  '- `rtk_record` — after you VERIFY a time-sensitive fact with your web/browser tools, record it (with',
  '  the sources you found). Updating an existing fact must be backed by enough independent sources —',
  '  RTK enforces this and keeps the previous value in history.',
  '- `rtk_refresh` — ask RTK to re-verify a fact via its research pipeline (if configured).',
  '',
  'Rules:',
  '- For anything that can change over time, call `rtk_lookup` first and prefer a `fresh` fact over your',
  '  own memory.',
  '- If a looked-up fact is `stale` or `expired`, or the conversation surfaces contradicting evidence,',
  '  VERIFY it with your web/browser tools and then call `rtk_record` to update it — do NOT silently',
  '  trust either the old fact or your own guess.',
  '- A value change with no sources will be rejected: always pass the `sources` you actually checked.',
].join('\n');

/**
 * Append the Realtime Knowledge tool rules to an existing rules/briefing string
 * (idempotent).
 *
 * @param existingRules The conversation's current rules/briefing (may be empty).
 * @returns The combined string with the RTK block appended once.
 */
export const withRealtimeKnowledgeRules = (existingRules?: string): string => {
  const base = (existingRules ?? '').trim();
  if (base.includes('Realtime knowledge (avoid stale answers)')) return base; // already present
  return base.length > 0 ? `${base}\n\n${REALTIME_KNOWLEDGE_TOOLS_RULES}` : REALTIME_KNOWLEDGE_TOOLS_RULES;
};

/**
 * Build the standing instructions for the IDE session super-memory, embedding
 * the concrete `sessionId` the agent must pass to every `ide_memory_*` tool.
 *
 * The memory is EPHEMERAL: it lives only while this chat tab is open and is
 * wiped when the tab closes. The agent should treat it as a small scratchpad for
 * things it must not re-derive each turn — NOT as a place to dump repo content
 * (the repo / MTUI map already holds that). Older notes auto-summarise at a
 * token budget, so the context it feeds back always stays lean.
 *
 * @param sessionId The session memory id to bind this conversation to.
 * @returns A rules block instructing the agent how + when to use session memory.
 */
export const buildIdeMemoryRules = (sessionId: string): string =>
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

/**
 * Append the IDE session-memory rules to an existing briefing string (idempotent).
 *
 * @param sessionId The session memory id to bind.
 * @param existingRules The conversation's current rules/briefing (may be empty).
 * @returns The combined string with the memory block appended once.
 */
export const withIdeMemoryRules = (sessionId: string, existingRules?: string): string => {
  const base = (existingRules ?? '').trim();
  if (base.includes('Session memory (your ephemeral scratchpad)')) return base; // already present
  const block = buildIdeMemoryRules(sessionId);
  return base.length > 0 ? `${base}\n\n${block}` : block;
};
