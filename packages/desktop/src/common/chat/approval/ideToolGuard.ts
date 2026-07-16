/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IDE Strict Mode tool guard — the PURE decision core that decides whether an
 * agent's tool-call permission request must be auto-denied so the agent is
 * forced to use the built-in `ide_*` / MTUI tooling instead of a CLI backend's
 * own native tools (Bash, Write, Edit, Read, Glob, Grep, …).
 *
 * ## Why this exists
 *
 * Inside an IDE workspace every repo read / search / edit should flow through
 * the `ide_*` MCP server (and `mtui`) so the work is visible, reviewable and
 * undoable through the IDE/MTUI gateway. A prompt reminder
 * (`buildPlanningGuard`) only *asks* the model to prefer those tools; the model
 * frequently ignores it and reaches for its own Bash/Write. This guard makes
 * the rule **hard**: when Strict IDE Mode is on, any permission request for a
 * non-whitelisted tool is denied automatically (no user prompt), so the only
 * way for the agent to act on the repo is the `ide_*` tools.
 *
 * This module is intentionally PURE (no DOM, no ipc, no React) so it can be unit
 * tested in isolation and reused by every platform handler (acp, aionrs, …).
 */

/** The localStorage key prefix under which Strict IDE Mode is toggled per root. */
export const IDE_STRICT_MODE_PREFIX = 'studio.ide.strict.';

/** Custom ACP adapter used by IDE conversations to deny native Claude tools before execution. */
export const STRICT_IDE_CLAUDE_AGENT_NAME = 'AionUi Strict Claude';
export const STRICT_IDE_CLAUDE_AGENT_DESCRIPTION =
  'Claude ACP adapter for Strict IDE Mode. Native filesystem and shell tools are disabled before execution.';

/**
 * Tool-name prefixes / exact names that REMAIN allowed under Strict IDE Mode.
 * Everything else is denied. Kept deliberately small: the built-in IDE MCP
 * tools (`ide_*`), the MTUI CLI, and the team coordination tools that also flow
 * through the MTUI gateway.
 */
const ALLOWED_TOOL_PREFIXES = ['ide_', 'team_', 'db_'] as const;
const ALLOWED_TOOL_NAMES = ['mtui', 'toolsearch'] as const;

/** Common native tool names/titles that Strict IDE Mode must always block (case-insensitive after normalize). */
const NATIVE_TOOL_MARKERS = [
  'bash',
  'sh',
  'shell',
  'terminal',
  'execute',
  'exec',
  'run',
  'powershell',
  'pwsh',
  'cmd',
  'run_terminal',
  'read',
  'read_file',
  'cat',
  'write',
  'write_file',
  'edit',
  'edit_file',
  'grep',
  'rg',
  'glob',
  'find',
  'ls',
  'dir',
  'list_dir',
  'sed',
  'patch',
  'str_replace',
  'apply_patch',
  'search',
  'search_file',
] as const;

const isSafeMtuiShellCommand = (command: string | undefined): boolean => {
  const value = command?.trim() ?? '';
  return /^mtui(?:\.exe)?(?:\s|$)/i.test(value) && !/[;&|><`\r\n]|\$\(/.test(value);
};

const isNativeLikeTool = (rawName: string | undefined): boolean => {
  const name = normalize(rawName);
  if (!name) return false;
  // Whitelist wins: a built-in `ide_*` / `team_*` / `mtui` / `db_` tool is NEVER
  // native, even though its name contains a substring like "search" (ide_search),
  // "read" (ide_read_file), "write" (team_write_file) or "edit" (team_edit_file).
  // Without this guard those allowed tools were wrongly flagged + blocked.
  if (
    ALLOWED_TOOL_NAMES.some((allowedName) => name === allowedName) ||
    ALLOWED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))
  ) {
    return false;
  }
  // Use word-boundary-ish matching so a marker only matches as a whole token,
  // not as an arbitrary substring of an unrelated identifier.
  return NATIVE_TOOL_MARKERS.some((m) => name === m || new RegExp(`(^|[^a-z0-9])${m}([^a-z0-9]|$)`).test(name));
};

/** MCP server names whose trusted tools may be auto-approved by the IDE plane. */
const ALLOWED_MCP_SERVERS = ['aionui-ide', 'builtin-ide', 'aionui-tool-selector'] as const;

/**
 * Mandatory remap table: a backend's native tool name → the built-in `ide_*`
 * tool the agent MUST use instead. Used to build the "đã đổi về …" message so
 * the agent re-issues the call with the correct tool instead of getting stuck.
 *
 * Keys are matched case-insensitively against the tool name AND the leading
 * token of a shell command (so `grep -rn foo` maps from `grep`).
 */
const TOOL_REMAP: ReadonlyArray<{ from: readonly string[]; to: string }> = [
  { from: ['grep', 'rg', 'ripgrep', 'ag', 'ack'], to: 'ide_search' },
  { from: ['glob', 'find', 'ls', 'dir', 'tree'], to: 'ide_glob' },
  {
    from: ['bash', 'sh', 'zsh', 'shell', 'powershell', 'pwsh', 'cmd', 'execute', 'exec', 'run', 'run_terminal_cmd'],
    to: 'ide_command',
  },
  { from: ['cat', 'read', 'read_file', 'head', 'tail', 'less', 'more', 'open'], to: 'ide_read_file' },
  { from: ['write', 'write_file', 'create_file', 'createfile', 'newfile'], to: 'team_write_file' },
  {
    from: [
      'edit',
      'edit_file',
      'editfile',
      'str_replace',
      'apply_patch',
      'applypatch',
      'patch',
      'sed',
      'awk',
      'multiedit',
    ],
    to: 'team_edit_file',
  },
];

/**
 * Resolve which `ide_*` tool a denied native tool should be remapped to. Tries
 * the explicit tool name first, then the leading token of any shell command.
 * Returns `null` when no rule matches (caller falls back to a generic message).
 */
export const resolveRemapTarget = (toolCall: GuardToolCall | undefined): string | null => {
  if (!toolCall) return null;
  const tokens: string[] = [];
  const push = (v: string | undefined): void => {
    const n = normalizeToken(v);
    if (n) tokens.push(n);
  };
  // Command content first so specific action (rg, ls, cat...) wins over wrapper title (Bash, Execute).
  const command = toolCall.raw_input?.command;
  if (typeof command === 'string') {
    const lead = command.trim().split(/\s+/)[0];
    push(lead);
    if (lead) {
      const base = lead
        .replace(/\.exe$/i, '')
        .split(/[\\/]/)
        .pop();
      push(base);
    }
  }
  push(toolCall.raw_input?.tool_name);
  push(toolCall.raw_input?.name);
  push(toolCall.title);
  // Split descriptive titles (e.g. "exec wants to use: Bash") into words so we can still detect "Bash", "Glob" etc.
  if (toolCall.title) {
    const cleaned = stripWrapperPhrases(toolCall.title);
    cleaned.split(/\s+/).forEach(push);
    // also push original cleaned for direct match
    push(cleaned);
  }
  for (const token of tokens) {
    const rule = TOOL_REMAP.find((r) => r.from.includes(token));
    if (rule) return rule.to;
  }
  return null;
};

/** Normalise a single token (lowercase, trimmed) for remap matching. */
const normalizeToken = (value: string | undefined): string => (value ?? '').trim().toLowerCase();

/** Aggressively strip wrapper phrases from titles/descriptions like "exec wants to use: Bash", "Execute: xxx", "wants to use". Never return 'exec' etc as label. */
const stripWrapperPhrases = (s: string): string => {
  let t = (s || '').trim();
  // Remove common descriptive wrappers (case-insensitive, repeated)
  t = t.replace(
    /^(exec|execute|bash|shell|run|terminal)\s*(wants to use|wants to execute|wants|to use|to execute)?:?\s*/gi,
    ''
  );
  t = t.replace(/^(Execute|exec|bash|shell):\s*/gi, '');
  t = t.replace(/\bexec\b/gi, ''); // last resort to kill stray 'exec'
  t = t.replace(/\s+/g, ' ').trim();
  return t;
};

/** The shape of a tool-call permission request this guard can reason about. */
export type GuardToolCall = {
  /** Stable id of the tool call (echoed back when confirming). */
  tool_call_id?: string;
  /** Tool name / title as advertised by the backend (e.g. "Bash", "ide_search"). */
  title?: string;
  /** ACP tool kind (e.g. "execute", "edit", "read"). */
  kind?: string;
  /** Raw input — may carry `command` (shell) or an explicit tool name. */
  raw_input?: {
    command?: string;
    name?: string;
    tool_name?: string;
    server?: string;
    [key: string]: unknown;
  };
};

/** A permission option offered by the backend. */
export type GuardPermissionOption = {
  option_id: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
};

/** Normalise an arbitrary identifier for prefix/exact matching. */
const normalize = (value: string | undefined): string => (value ?? '').trim().toLowerCase();

/**
 * Decide whether a tool name / identifier belongs to the allowed `ide_*` /
 * MTUI tooling. Matching is case-insensitive and prefix-based. Every `ide_*`
 * tool advertised by the built-in MCP server is valid, including `ide_grep`
 * and `ide_glob`.
 */
export const isAllowedIdeTool = (rawName: string | undefined): boolean => {
  const name = normalize(rawName);
  if (name.length === 0) return false;
  return (
    ALLOWED_TOOL_NAMES.some((allowedName) => name === allowedName) ||
    ALLOWED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
};

/**
 * Extract only fields that explicitly identify the requested tool. Permission
 * metadata such as `kind`, commands, queries, paths, and actions describe what
 * an already-identified tool will do and must not override its trusted identity.
 */
const explicitToolNames = (toolCall: GuardToolCall): string[] =>
  [toolCall.raw_input?.tool_name, toolCall.raw_input?.name, toolCall.title].filter(
    (name): name is string => typeof name === 'string' && name.trim().length > 0
  );

/**
 * The core decision: should this tool call be ALLOWED under Strict IDE Mode?
 *
 * An explicit IDE/MTUI gateway identity wins over generic permission metadata.
 * Otherwise an explicitly native identity is denied, a trusted IDE MCP server is
 * allowed, and unknown calls fail closed.
 */
export const isToolCallAllowedInStrictMode = (toolCall: GuardToolCall | undefined): boolean => {
  if (!toolCall) return false;

  // A native shell may act only as the transport for a single MTUI command.
  // Shell chaining/substitution stays denied so Strict Mode cannot be bypassed.
  if (isSafeMtuiShellCommand(toolCall.raw_input?.command)) return true;

  const identities = explicitToolNames(toolCall);
  const hasAllowedIdentity = identities.some((name) => isAllowedIdeTool(name));
  const hasNativeIdentity = identities.some((name) => isNativeLikeTool(name));
  if (hasNativeIdentity) return false;
  if (hasAllowedIdentity) return true;
  if (identities.length > 0) return false;

  const server = normalize(toolCall.raw_input?.server);
  return server.length > 0 && ALLOWED_MCP_SERVERS.some((allowedServer) => server === allowedServer);
};

/**
 * Pick the option to send back when auto-denying. Prefers a one-shot reject
 * (`reject_once`), then any reject option, then any option whose name looks like
 * a rejection. Returns `null` when the backend offered no usable option.
 */
export const pickRejectOption = (
  options: ReadonlyArray<GuardPermissionOption> | undefined
): GuardPermissionOption | null => {
  if (!options || options.length === 0) return null;
  return (
    options.find((o) => o.kind === 'reject_once') ??
    options.find((o) => o.kind === 'reject_always') ??
    options.find((o) => /reject|deny|no|decline/i.test(o.name)) ??
    null
  );
};

/** The result of evaluating a permission request under Strict IDE Mode. */
export type StrictModeDecision = {
  /** Whether the request must be auto-denied. */
  deny: boolean;
  /** The option id to send back when denying (null when none usable). */
  rejectOptionId: string | null;
  /** A short human-readable reason (for logging / a system bubble). */
  reason: string;
};

/**
 * Build the mandatory-remap message shown when a native tool is denied, e.g.
 * `🔁 "grep" đã đổi về \`ide_search\` theo quy tắc bắt buộc.` When no remap rule
 * matches, returns a generic "use the ide_* tools" instruction.
 */
export const buildRemapReason = (toolCall: GuardToolCall | undefined): string => {
  const rawLabel = toolCall?.title || toolCall?.raw_input?.command?.trim().split(/\s+/)[0] || 'unknown tool';
  const toolLabel = stripWrapperPhrases(rawLabel) || rawLabel;
  const target = resolveRemapTarget(toolCall);
  if (target) {
    return `🚫 Strict IDE Mode đã chặn ${toolLabel} vì tool native không được phép trong workspace này. Hãy dùng \`${target}\` thay thế. Tool gốc không được chạy.`;
  }
  return '🚫 Strict IDE Mode đã chặn tool native vì không có ánh xạ an toàn. Hãy dùng tool ide_* phù hợp. Tool gốc không được chạy.';
};

/**
 * Evaluate a full permission request. Returns a decision telling the caller
 * whether to auto-deny and which option id to send back.
 *
 * @param enabled  Whether Strict IDE Mode is active for this workspace.
 * @param toolCall The tool call the backend wants to run.
 * @param options  The permission options the backend offered.
 */
export const evaluateStrictModePermission = (
  enabled: boolean,
  toolCall: GuardToolCall | undefined,
  options: ReadonlyArray<GuardPermissionOption> | undefined
): StrictModeDecision => {
  if (!enabled) {
    return { deny: false, rejectOptionId: null, reason: 'strict-mode-off' };
  }
  if (isToolCallAllowedInStrictMode(toolCall)) {
    return { deny: false, rejectOptionId: null, reason: 'allowed-ide-tool' };
  }
  const rejectOption = pickRejectOption(options);
  return {
    deny: true,
    rejectOptionId: rejectOption?.option_id ?? null,
    reason: buildRemapReason(toolCall),
  };
};

// ---------------------------------------------------------------------------
// Confirmation-shaped requests (aionrs legacy path)
// ---------------------------------------------------------------------------

/**
 * The aionrs backend emits a Confirmation-shaped permission payload whose
 * options are `{ label, value }` (no ACP `kind`), and whose tool identity is
 * carried by `title` / `action` / `command_type`. This evaluates that shape.
 */
export type GuardConfirmation = {
  title?: string;
  description?: string;
  action?: string;
  command_type?: string;
  call_id?: string;
  options?: Array<{ label: string; value: unknown }>;
};

/** Pick the reject option from a Confirmation: a value/label that reads as "no". */
const pickConfirmationReject = (confirmation: GuardConfirmation): unknown | null => {
  const options = confirmation.options ?? [];
  if (options.length === 0) return null;
  const rejectLike = options.find(
    (o) =>
      /reject|deny|no|decline|cancel|disallow/i.test(o.label) || /reject|deny|no|decline|cancel/i.test(String(o.value))
  );
  return (rejectLike ?? null)?.value ?? null;
};

/**
 * Evaluate a Confirmation-shaped (aionrs) permission request under Strict IDE
 * Mode. Mirrors {@link evaluateStrictModePermission} but for the legacy shape.
 * The reject "key" returned is the option `value` (what aionrs expects back).
 */
export const evaluateStrictModeConfirmation = (
  enabled: boolean,
  confirmation: GuardConfirmation | undefined
): { deny: boolean; rejectKey: string | null; reason: string } => {
  if (!enabled) return { deny: false, rejectKey: null, reason: 'strict-mode-off' };
  if (!confirmation) return { deny: false, rejectKey: null, reason: 'no-confirmation' };

  // Identify the tool from any of the Confirmation's descriptive fields.
  const candidates = [confirmation.title, confirmation.action, confirmation.command_type];
  if (candidates.some((c) => isAllowedIdeTool(c))) {
    return { deny: false, rejectKey: null, reason: 'allowed-ide-tool' };
  }

  const rejectValue = pickConfirmationReject(confirmation);
  // Reuse the remap message builder by mapping the Confirmation's descriptive
  // fields onto a GuardToolCall shape (title + command_type as a pseudo command).
  const asToolCall: GuardToolCall = {
    title: confirmation.title || confirmation.action,
    raw_input: { command: confirmation.command_type },
  };
  return {
    deny: true,
    rejectKey: rejectValue == null ? null : String(rejectValue),
    reason: buildRemapReason(asToolCall),
  };
};
