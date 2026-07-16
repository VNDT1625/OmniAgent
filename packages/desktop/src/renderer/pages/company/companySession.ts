/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Role-chat session helper for the Agent Company (Part 2b — Company chat).
 *
 * Bridges a company *role* (president / division head / worker) to a normal 1-1
 * chat conversation with that role's assigned executor (CLI engine or
 * assistant). The mapping from a role to a conversation is remembered in
 * `localStorage` so re-clicking the same role re-opens its existing chat instead
 * of spawning a new one.
 *
 * All conversation-creation subtleties are delegated to the shared renderer
 * helpers ({@link buildCliAgentParams} / {@link buildPresetAssistantParams}),
 * which already handle every per-backend detail. This module only:
 *  - resolves which executor backs the role,
 *  - composes a concise company "briefing" (company + division + rules), and
 *  - injects that briefing where it is safe to do so.
 *
 * Process boundary: Renderer module. No Node.js APIs. Only **types** are
 * borrowed from Main-process modules via `import type` (erased at compile time).
 */

import { ipcBridge } from '@/common';
import type { ICreateConversationParams } from '@/common/adapter/ipcBridge';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { CompanyStructure, RoleNode, RoleCapabilities } from '@process/company/companyOrchestrator';
import {
  buildCliAgentParams,
  buildPresetAssistantParams,
} from '@/renderer/pages/conversation/utils/createConversationParams';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import type { AgentMetadata } from '@/renderer/utils/model/agentTypes';
import { fetchDetectedAgents } from '@/renderer/utils/model/agentTypes';
import { composeSoul, directReportsOf } from './pipeline/soulComposer';
import { ensureBackendMcpCatalog, toSessionMcpServer } from '@/renderer/hooks/mcp/catalog';
import {
  BROWSER_CONTROL_MCP_NAME,
  IDE_MCP_NAME,
  withSuperBrowserRules,
  withIdeToolRules,
} from '@/renderer/pages/conversation/hooks/superGuidance';
import type { ISessionMcpServer } from '@/common/config/storage';

/**
 * `localStorage` key under which the renderer remembers the conversation opened
 * for each company role. Keyed by `"<companyId>::<roleId>"` → conversation id.
 */
export const ROLE_CONVERSATIONS_STORAGE_KEY = 'github.com/VNDT1625/OmniAgentpany.roleConversations';

/** Build the storage map key for one role. */
const roleKey = (companyId: string, roleId: string): string => `${companyId}::${roleId}`;

/**
 * Read the remembered role→conversation map from `localStorage`. Returns an
 * empty map on any failure (private mode / quota / corrupt JSON) — mirrors the
 * safe try/catch JSON style in `pages/company/constants.ts`.
 */
export const loadCompanyRoleConversations = (): Record<string, string> => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(ROLE_CONVERSATIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) map[key] = value;
    }
    return map;
  } catch {
    return {};
  }
};

/** Persist one role→conversation mapping (best-effort; merges into the map). */
export const saveCompanyRoleConversation = (key: string, convId: string): void => {
  if (typeof window === 'undefined') return;
  try {
    const map = loadCompanyRoleConversations();
    map[key] = convId;
    window.localStorage.setItem(ROLE_CONVERSATIONS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage failures — the mapping is a non-critical optimisation.
  }
};

/** Human label for a role kind, used inside the (agent-facing) briefing text. */
const roleKindLabel = (role: RoleNode['role']): string => {
  switch (role) {
    case 'president':
      return 'President';
    case 'division-head':
      return 'Division head';
    case 'worker':
      return 'Worker';
    default:
      return 'Member';
  }
};

/**
 * Find the human-readable division name for a role, by matching its
 * `divisionId` against the division-head nodes in the structure. Falls back to
 * the raw division id when no head node carries a name.
 */
const findDivisionName = (structure: CompanyStructure | null, divisionId?: string): string | undefined => {
  if (!structure || !divisionId) return undefined;
  let found: string | undefined;
  const walk = (node: RoleNode): void => {
    if (found) return;
    if (node.role === 'division-head' && node.divisionId === divisionId) {
      found = node.name;
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(structure.root);
  return found ?? divisionId;
};

/**
 * Compose a concise markdown briefing for the role: who they are in the company,
 * their soul/workflow (what they do, who they may delegate to), what they are
 * responsible for, which division they belong to, and the company rules they
 * must follow. This is the single source of truth that tells an agent who it
 * is — without it, the chat looks like a plain general-purpose assistant.
 */
const buildBriefing = (params: {
  companyName: string;
  role: RoleNode;
  structure: CompanyStructure | null;
  rules: string[];
}): string => {
  const { companyName, role, structure, rules } = params;
  const lines: string[] = [];
  lines.push(`# Company briefing`, '');
  lines.push(`**Company:** ${companyName}`);
  lines.push(`**Your role:** ${role.name} (${roleKindLabel(role.role)})`);

  const divisionName = findDivisionName(structure, role.divisionId);
  if (divisionName) lines.push(`**Division:** ${divisionName}`);
  if (role.responsibilities && role.responsibilities.trim().length > 0) {
    lines.push(`**Responsibilities:** ${role.responsibilities.trim()}`);
  }

  // Soul/workflow — the same prompt the recursive pipeline uses, so a 1-1 chat
  // and a pipeline run see the role identically. composeSoul covers the role
  // type, direct reports (delegation targets), and rules.
  lines.push('', '## Soul / workflow', '');
  lines.push(
    composeSoul({
      companyName,
      node: role,
      directReports: directReportsOf(role),
      rules,
    })
  );

  return lines.join('\n');
};

/** Pick the first runnable CLI agent from the detected pool, or null. */
const firstAvailableCli = (agents: AgentMetadata[]): AgentMetadata | null => {
  for (const agent of agents) {
    if (agent.available !== false) return agent;
  }
  return null;
};

/**
 * Best-effort, ACP-safe model override. The model assigned to a role is only
 * applied for the aionrs backend (whose `model.use_model` slot is a provider
 * model id). For ACP/other backends the model is carried differently and the
 * executor default is correct, so we leave `params.model` untouched. The
 * override is also skipped unless the requested model actually exists in a
 * configured provider — otherwise the executor default is used.
 */
const applyAssignmentModel = async (params: ICreateConversationParams, model?: string): Promise<void> => {
  if (!model || params.type !== 'aionrs') return;
  const current = params.model as { use_model?: string } | undefined;
  if (!current || typeof current.use_model !== 'string') return;
  try {
    const providers = await ipcBridge.mode.listProviders.invoke();
    const exists =
      Array.isArray(providers) &&
      providers.some((provider) => Array.isArray(provider.models) && provider.models.includes(model));
    if (exists) current.use_model = model;
  } catch {
    // Provider lookup failed — keep the built-in default (safe).
  }
};

/**
 * Grant a role's capabilities (Requirement 9) onto the conversation params.
 *
 * MCP servers need TWO channels, mirroring the Guid page (`useGuidSend`) and the
 * Super toggle (`useSuperMode`):
 *  - **User servers** are attached by id via `extra.selected_mcp_server_ids`.
 *  - **Built-in servers** (e.g. the Browser-Control "Super" server, the Testing
 *    server) run as in-process SSE hosts on ephemeral ports, so the backend
 *    cannot reload them from the catalog by id alone — they must be sent as full
 *    session configs via `extra.selected_session_mcp_servers`
 *    ({@link toSessionMcpServer}). Without this, granting "browse the web" to a
 *    role had no effect (the server never attached).
 *
 * When the Browser-Control server is among the granted built-ins, the Super
 * standing-instructions are appended to the briefing so the agent uses the
 * embedded `browser_*` tools (and never shells out / spawns sub-agents) — the
 * same guidance the manual Super toggle injects.
 *
 * @returns the (possibly Super-augmented) briefing to use as `preset_context`.
 */
const applyCapabilities = async (
  params: ICreateConversationParams,
  capabilities: RoleCapabilities | undefined,
  briefing: string
): Promise<string> => {
  if (!params.extra) params.extra = {};
  if (!capabilities) return briefing;

  let nextBriefing = briefing;

  const skills = capabilities.skills;
  if (Array.isArray(skills) && skills.length > 0) {
    params.extra.preset_enabled_skills = skills;
  }
  if (typeof capabilities.sessionMode === 'string' && capabilities.sessionMode.length > 0) {
    params.extra.session_mode = capabilities.sessionMode;
  }

  const grantedIds = Array.isArray(capabilities.mcpServerIds) ? capabilities.mcpServerIds : [];
  if (grantedIds.length === 0) return nextBriefing;

  // Resolve the granted ids against the live MCP catalog so we can split
  // user (by id) from built-in (by full session config). Best-effort: a catalog
  // failure degrades to the id-only path so a normal user server still attaches.
  try {
    const { allServers } = await ensureBackendMcpCatalog();
    const grantedSet = new Set(grantedIds);
    const matched = allServers.filter((s) => grantedSet.has(s.id) || grantedSet.has(s.name));

    const userIds = matched.filter((s) => s.builtin !== true).map((s) => s.id);
    const sessionServers: ISessionMcpServer[] = matched
      .filter((s) => s.builtin === true)
      .map((s) => toSessionMcpServer(s));

    // Ids the catalog did not resolve — still forward them by id so a server the
    // catalog has not surfaced yet is not silently dropped.
    const resolvedKeys = new Set(matched.flatMap((s) => [s.id, s.name]));
    const unresolved = grantedIds.filter((id) => !resolvedKeys.has(id));

    const idList = Array.from(new Set([...userIds, ...unresolved]));
    if (idList.length > 0) params.extra.selected_mcp_server_ids = idList;
    if (sessionServers.length > 0) params.extra.selected_session_mcp_servers = sessionServers;

    // If the Browser-Control "Super" server is attached, append its standing
    // instructions so the agent drives the embedded browser correctly.
    const hasBrowserControl = matched.some((s) => s.builtin === true && s.name === BROWSER_CONTROL_MCP_NAME);
    if (hasBrowserControl) nextBriefing = withSuperBrowserRules(nextBriefing);

    // If the IDE server is attached, append the IDE tool guidance so the agent
    // uses the embedded `ide_*` repo-intelligence tools (scan/search/nav/read).
    const hasIde = matched.some((s) => s.builtin === true && s.name === IDE_MCP_NAME);
    if (hasIde) nextBriefing = withIdeToolRules(nextBriefing);
  } catch {
    // Catalog unavailable — fall back to the id-only path (user servers only).
    params.extra.selected_mcp_server_ids = grantedIds;
  }

  return nextBriefing;
};

/** Input for {@link openRoleChat}. */
export type OpenRoleChatInput = {
  /** Company the role belongs to. */
  companyId: string;
  /** Display name for the company (used in the conversation name + briefing). */
  companyName: string;
  /** The role node to open a chat with. */
  role: RoleNode;
  /** The active company structure (used to resolve the division name). */
  structure: CompanyStructure | null;
  /** The company rules (folded into the briefing). */
  rules: string[];
  /** The assignable executor pool (kept for parity; resolution re-fetches live data). */
  agents?: unknown;
  /** UI language, forwarded to {@link buildPresetAssistantParams}. */
  language: string;
  /**
   * Skip the briefing-primer turn. Set to `true` by callers that send their
   * own initial prompt (e.g. the recursive pipeline, which dispatches
   * `briefing + task` together) so we do not contend on the conversation's
   * turn sequencing. Default `false` — the user-facing 1-1 chat path.
   */
  skipPrimer?: boolean;
};

/**
 * Resolve the role's executor and build the matching conversation params.
 * Returns null when no runnable executor can be resolved (no assistant match
 * and no CLI engine available at all).
 */
const buildParamsForRole = async (role: RoleNode, language: string): Promise<ICreateConversationParams | null> => {
  const assignment = role.assignment;

  if (assignment?.kind === 'assistant') {
    const assistants = await ipcBridge.assistants.list.invoke().catch((): Assistant[] => []);
    const assistant = (assistants || []).find((a) => a.id === assignment.refId);
    if (assistant) {
      // BUG FIX: an assistant only runs if its `preset_agent_type` resolves to a
      // real, installed engine. Drafts created from an LLM proposal may carry an
      // engine id that does not exist on this machine — the assistant is created
      // but unrunnable, and aioncore rejects the chat with "ACP agent requires
      // either agent_id or backend in extra". Validate the engine against the
      // detected pool and, when it is missing, substitute a runnable one so the
      // conversation always has a valid backend.
      const detected = await fetchDetectedAgents();
      const engine = assistant.preset_agent_type;
      const engineOk = detected.some(
        (a) => a.available !== false && (a.backend === engine || a.agent_type === engine || a.id === engine)
      );
      if (engineOk) return buildPresetAssistantParams(assistant, '', language);
      const fallback = firstAvailableCli(detected);
      if (fallback) {
        // Run the assistant on a real engine while keeping its rules/skills/model.
        const fallbackEngine = fallback.backend || fallback.agent_type;
        return buildPresetAssistantParams({ ...assistant, preset_agent_type: fallbackEngine }, '', language);
      }
      // No engine at all — let the generic fallback below try a bare CLI.
    }
  } else if (assignment?.kind === 'cli') {
    const detected = await fetchDetectedAgents();
    const agent = detected.find(
      (a) =>
        a.available !== false &&
        (a.id === assignment.refId || a.agent_type === assignment.refId || a.backend === assignment.refId)
    );
    if (agent) return buildCliAgentParams(agent, '');
    // The assigned CLI is not installed/available on this machine — fall through
    // to a runnable engine below instead of building params for a dead CLI
    // (which fails at chat time).
  }

  // Fallback (draft / no assignment / not found): first available CLI engine.
  const detected = await fetchDetectedAgents();
  const cli = firstAvailableCli(detected);
  if (cli) return buildCliAgentParams(cli, '');
  return null;
};

/**
 * Open (or reuse) a 1-1 chat with the executor assigned to a company role.
 *
 * @returns the conversation id to navigate to, or `null` if the chat could not
 * be opened (no runnable executor, or the backend create failed). Never throws.
 *
 * ## Briefing injection
 *
 * The role briefing (identity + soul/workflow + rules) is **always** injected
 * so a chat opened from the Company page never looks like a plain general-purpose
 * assistant. Two delivery channels are used so it works regardless of backend:
 *
 * 1. `extra.preset_context` — picked up by aioncore for preset-aware backends
 *    (assistants and ACP sessions that read the slot).
 * 2. A primer turn sent immediately after create — the briefing is dispatched
 *    via `conversation.sendMessage` so the agent is told who it is even when
 *    the backend ignores `preset_context`. The primer is sent in the
 *    background (does not await turn completion) so the page navigates fast.
 *    This only fires for newly-created conversations, never for reused ones.
 */
export const openRoleChat = async (input: OpenRoleChatInput): Promise<string | null> => {
  const { companyId, companyName, role, structure, rules, language, skipPrimer } = input;
  try {
    // 1. Reuse an existing conversation for this role when it still exists.
    const key = roleKey(companyId, role.id);
    const existingId = loadCompanyRoleConversations()[key];
    if (existingId) {
      const existing = await getConversationOrNull(existingId).catch((): null => null);
      if (existing) return existingId;
    }

    // 2. Resolve the executor and build the conversation params.
    const params = await buildParamsForRole(role, language);
    if (!params) return null;

    // 3. Compose the company briefing (identity + soul + rules).
    let briefing = buildBriefing({ companyName, role, structure, rules });

    if (!params.extra) params.extra = {};

    // 4. Grant the role's capabilities (Requirement 9): MCP servers (user by id +
    // built-in/"Super" by full session config), skills, and the permission/super
    // session mode. Returns the briefing possibly augmented with Super browser
    // guidance when the Browser-Control server is attached. Without this the
    // agent often cannot do its job (browse the web, edit Office files, run
    // sensitive commands).
    briefing = await applyCapabilities(params, role.assignment?.capabilities, briefing);

    // 5. Inject the (capability-augmented) briefing as preset_context for backends
    //    that read it. We always set it (prepended) so an assistant that already
    //    has rules keeps them, and a CLI/ACP session also gets the company context.
    const existingContext = typeof params.extra.preset_context === 'string' ? params.extra.preset_context : '';
    params.extra.preset_context = existingContext.length > 0 ? `${briefing}\n\n${existingContext}` : briefing;

    // 6. Clear, human-readable conversation name.
    params.name = `${companyName} · ${role.name}`;

    // 7. Apply the role's model (aionrs-only, provider-validated; ACP-safe).
    await applyAssignmentModel(params, role.assignment?.model);

    // 8. Create the conversation and remember the mapping.
    const conv = await ipcBridge.conversation.create.invoke(params);
    if (conv?.id) {
      saveCompanyRoleConversation(key, conv.id);

      // 9. Primer turn — give the agent its identity even when the backend
      // ignores `preset_context`. Sent fire-and-forget so the page navigates
      // immediately; the agent will process it before answering the user.
      // Skipped when the caller (e.g. the pipeline) sends its own initial
      // prompt that already contains the briefing.
      if (!skipPrimer) {
        void ipcBridge.conversation.sendMessage
          .invoke({
            conversation_id: conv.id,
            input: buildPrimerMessage(briefing),
          })
          .catch((error) => {
            console.warn('[CompanySession] briefing primer failed (non-fatal):', error);
          });
      }

      return conv.id;
    }
    return null;
  } catch (error) {
    console.error('[CompanySession] openRoleChat failed:', error);
    return null;
  }
};

/**
 * Wrap the briefing in a clear instruction so the agent treats it as a
 * system-style identity declaration, not as a user request to act on.
 */
const buildPrimerMessage = (briefing: string): string =>
  [
    'SYSTEM BRIEFING — this is your identity for this entire conversation.',
    'Read it carefully and adopt the role exactly as described before responding to anything.',
    'Acknowledge with a single short line confirming who you are and what you are responsible for; do not list every detail back.',
    '',
    briefing,
  ].join('\n');
