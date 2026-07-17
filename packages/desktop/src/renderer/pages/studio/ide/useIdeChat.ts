/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useIdeChat` — multi-tab CLI-agent chat for the IDE workspace.
 *
 * Replaces the previous in-IDE Ask + Agent panels (one-shot Q&A and a weak
 * ReAct loop) with the MAIN conversation/CLI-agent system: every tab is a real
 * `TChatConversation` whose `extra.workspace` is pinned to the IDE's open
 * folder, so a CLI agent (Claude Code / Codex / Gemini …) runs with that folder
 * as its cwd and can read every subdirectory. Conversations also appear in the
 * global sidebar history and survive an app restart.
 *
 * "Multiple agents at once" = multiple tabs = multiple conversations. Each tab
 * stores only the `id`; the embedded `<ChatConversation>` component fetches the
 * full {@link TChatConversation} via the same SWR cache the routed
 * `/conversation/:id` page uses.
 *
 * Renderer-only: talks to Main via `ipcBridge.conversation.create/delete` and
 * the existing conversation cache. Tab ids are persisted to `localStorage` per
 * `rootPath` so reopening the same folder restores its tabs (stale ids are
 * pruned on reload via `getConversationOrNull`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ipcBridge } from '@/common';

import type { Assistant } from '@/common/types/agent/assistantTypes';
import { getAskMode } from '@/common/types/agent/agentModes';
import { resolveAgentBackendKey } from '@/common/utils/buildAgentConversationParams';

import type { AgentMetadata } from '@/renderer/utils/model/agentTypes';
import { emitter } from '@/renderer/utils/emitter';
import {
  buildCliAgentParams,
  buildPresetAssistantParams,
} from '@/renderer/pages/conversation/utils/createConversationParams';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import {
  enforceStrictIdeSessionMode,
  isStrictIdeModeEnabled,
} from '@/renderer/pages/conversation/platforms/strictIdeModeGuard';

import { ensureBackendMcpCatalog, toSessionMcpServer } from '@/renderer/hooks/mcp/catalog';
import {
  BROWSER_CONTROL_MCP_NAME,
  IDE_MCP_NAME,
  withIdeMemoryRules,
  withIdeToolRules,
} from '@/renderer/pages/conversation/hooks/superGuidance';
import { buildWorkspacePrimer as buildWorkspacePrimerShared } from '@process/ide/workspacePrimer';
import type { ISessionMcpServer, TChatConversation } from '@/common/config/storage';
import { ideClient } from './ideClient';

type IdeWorkspaceConversationExtra = {
  workspace?: string;
  team_id?: string;
  teamId?: string;
  cron_job_id?: string;
};

/** Normalize equivalent Windows workspace spellings before matching IDE history. */
const normalizeIdeWorkspaceIdentity = (workspace: string): string => {
  const normalized = workspace
    .trim()
    .replace(/^\\\\\?\\/, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
};

/** Return whether a user conversation belongs in this IDE workspace's history. */
export const isConversationForIdeWorkspace = (conversation: TChatConversation, rootPath: string): boolean => {
  const extra = conversation.extra as IdeWorkspaceConversationExtra | undefined;
  if (!extra?.workspace || extra.team_id || extra.teamId || extra.cron_job_id) return false;
  return normalizeIdeWorkspaceIdentity(extra.workspace) === normalizeIdeWorkspaceIdentity(rootPath);
};

/** localStorage key for the per-repo tab id list. */
const STORAGE_PREFIX = 'studio.ide.chatTabs.';
/** localStorage key for the per-repo Planning Mode flag. */
const PLANNING_PREFIX = 'studio.ide.planning.';
/** Max tabs kept per repo (defensive — UI is fine with many). */
const MAX_TABS = 12;

/**
 * The tool-preference rule, seeded ONCE into a tab's session memory (a pinned
 * note) when the tab opens — instead of appending a reminder to every message.
 *
 * In an IDE workspace every repo read / search / edit should flow through the
 * `ide_*` / MTUI tools (visible, reviewable, undoable). Rather than nag on each
 * turn, we record this rule in the agent's recall-on-demand memory; Strict IDE
 * Mode still hard-enforces the remap (`ideToolGuard`) regardless.
 */
const IDE_TOOL_PREFERENCE_NOTE =
  'Prefer AionUi system tools (ide_* and team_*) for repository work. When Strict IDE Mode is enabled, native filesystem and shell tools are blocked; use the specific ide_* tool named in the denial message. Strict Mode does not reroute or execute denied tools. When Strict Mode is disabled, the selected default or YOLO permission mode applies normally.';

const buildCloudWorkspaceGuide = (cloud: IdeChatCloudWorkspace): string =>
  [
    `Cloud workspace rule: this IDE is mounted from cloud workspace "${cloud.workspaceId}".`,
    `Relay URL: ${cloud.relayBaseUrl}.`,
    `The local path is only a materialized cache: ${cloud.cachePath}.`,
    'Treat the cloud relay as source of truth. For every repo read/search/edit/test task, use the attached cloud AionUi MCP tools (`ide_*`, `team_claim_file`, `team_edit_file`, `team_write_file`, `ide_command`) instead of native filesystem tools.',
    'Before changing an existing file, claim it with `team_claim_file`; release it with `team_release_file` when finished. If a lease is held by another client, report that conflict instead of overwriting.',
  ].join('\n');

/** One open chat tab in the IDE — just the conversation id + a display title. */
export type IdeChatTab = {
  /** Conversation id (matches the route /conversation/:id). */
  id: string;
  /** Tab label (conversation name; falls back to the agent name). */
  title: string;
  /**
   * Ephemeral session super-memory id bound to this tab. The agent receives it
   * in the workspace primer and uses it for `ide_memory_*` tools; closing the
   * tab clears the matching session (RAM-only, gone on close).
   */
  memId: string;
};

/** Keep the selected tab during a background tab-list refresh when it still exists. */
export const resolveRestoredIdeChatActiveId = (
  restored: readonly IdeChatTab[],
  currentId: string | null
): string | null => (currentId && restored.some((tab) => tab.id === currentId) ? currentId : (restored[0]?.id ?? null));

/** Select the nearest remaining tab after closing the active one. */
export const resolveIdeChatActiveIdAfterClose = (tabs: readonly IdeChatTab[], closingId: string): string | null => {
  const closingIndex = tabs.findIndex((tab) => tab.id === closingId);
  const remaining = tabs.filter((tab) => tab.id !== closingId);
  if (closingIndex < 0 || remaining.length === 0) return null;
  return remaining[Math.min(closingIndex, remaining.length - 1)]?.id ?? null;
};

/** What the caller picks when opening a new tab. */
export type IdeChatLauncher =
  | { kind: 'cli'; agent: AgentMetadata }
  | { kind: 'preset'; assistant: Assistant; language: string };

export type IdeChatCloudWorkspace = {
  workspaceId: string;
  relayBaseUrl: string;
  cachePath: string;
  remoteMcpServer: ISessionMcpServer;
};

export type IdeChatOptions = {
  cloudWorkspace?: IdeChatCloudWorkspace | null;
};

/** Public shape returned by {@link useIdeChat}. */
export type UseIdeChat = {
  tabs: IdeChatTab[];
  /** Active tab id (selected in the IDE chat panel), or null when no tabs. */
  activeId: string | null;
  /** Whether new IDE chats must ask clarifying questions and create a spec directory before implementation. */
  planningEnabled: boolean;
  /** Whether a new-tab create call is in flight (UI shows a spinner). */
  creating: boolean;
  /** Open a new conversation tab pinned to the current rootPath. */
  open: (launcher: IdeChatLauncher) => Promise<string | null>;
  /** Switch the active tab. */
  setActive: (id: string) => void;
  /** Close a tab (deletes the underlying conversation). */
  close: (id: string) => Promise<void>;
  /** Update a tab's title (after the model picker / rename). */
  rename: (id: string, title: string) => void;
  /** Toggle Planning Mode for this workspace. */
  setPlanningEnabled: (enabled: boolean) => void;
};

/** A persisted tab record (id + the ephemeral memory id bound to it). */
type PersistedTab = { id: string; memId: string };

/** Generate a fresh ephemeral session-memory id for a new tab. */
const newMemId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      return `ide-mem-${crypto.randomUUID()}`;
  } catch {
    /* crypto unavailable — fall through */
  }
  return `ide-mem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

/** Read the persisted tab records for `rootPath` (tolerant of corruption + legacy string[]). */
const readPersistedTabs = (rootPath: string): PersistedTab[] => {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + rootPath);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PersistedTab[] = [];
    for (const entry of parsed.slice(0, MAX_TABS)) {
      if (typeof entry === 'string') {
        out.push({ id: entry, memId: newMemId() }); // legacy shape
      } else if (entry && typeof entry === 'object' && typeof (entry as PersistedTab).id === 'string') {
        const rec = entry as PersistedTab;
        out.push({ id: rec.id, memId: typeof rec.memId === 'string' && rec.memId ? rec.memId : newMemId() });
      }
    }
    return out;
  } catch {
    return [];
  }
};

/** Persist the tab records for `rootPath` (silently ignoring quota errors). */
const writePersistedTabs = (rootPath: string, records: PersistedTab[]): void => {
  try {
    localStorage.setItem(STORAGE_PREFIX + rootPath, JSON.stringify(records.slice(0, MAX_TABS)));
  } catch {
    /* localStorage unavailable / quota exceeded — non-fatal */
  }
};

/** Read the persisted Planning Mode flag for `rootPath`. */
const readPlanningEnabled = (rootPath: string): boolean => {
  try {
    return localStorage.getItem(PLANNING_PREFIX + rootPath) === '1';
  } catch {
    return false;
  }
};

/** Persist the Planning Mode flag for `rootPath`. */
const writePlanningEnabled = (rootPath: string, enabled: boolean): void => {
  try {
    localStorage.setItem(PLANNING_PREFIX + rootPath, enabled ? '1' : '0');
  } catch {
    /* localStorage unavailable / quota exceeded — non-fatal */
  }
};

/**
 * Build the lightweight IDE primer injected when a tab opens without a task
 * yet. Delegates to the shared Main-process builder so the Omni External MCP
 * Gateway returns the same primer to external hosts without forking the source
 * of truth.
 */
const buildWorkspacePrimer = (
  rootPath: string,
  rules: readonly string[],
  planningEnabled: boolean,
  memId: string
): string => buildWorkspacePrimerShared({ rootPath, rules, planningEnabled, sessionMemoryId: memId });

/**
 * Resolve the built-in IDE MCP server (`aionui-ide`, an in-process SSE host
 * registered at boot) as a live session-server snapshot.
 * Attaching it to an IDE chat tab is what actually gives the agent the `ide_*`
 * repo-intelligence tools AND the `ide_memory_*` session-memory tools.
 */
type IdeMcpCatalog = {
  ideServer: ISessionMcpServer;
  browserServer?: ISessionMcpServer;
};

const resolveIdeMcpCatalog = async (): Promise<IdeMcpCatalog> => {
  const { allServers } = await ensureBackendMcpCatalog();
  const server = allServers.find((candidate) => candidate.name === IDE_MCP_NAME);
  if (!server) throw new Error(`Required MCP server ${IDE_MCP_NAME} is unavailable`);
  const browserServer = allServers.find((candidate) => candidate.name === BROWSER_CONTROL_MCP_NAME);
  return {
    ideServer: toSessionMcpServer(server),
    ...(browserServer ? { browserServer: toSessionMcpServer(browserServer) } : {}),
  };
};

/** Replace managed MCP snapshots while retaining unrelated and cloud servers. */
export const mergeIdeSessionMcpServers = (
  existing: readonly ISessionMcpServer[],
  ideServer: ISessionMcpServer,
  cloudServer?: ISessionMcpServer | null,
  browserServer?: ISessionMcpServer
): ISessionMcpServer[] => {
  // Studio IDE conversations always receive the live Browser-Control snapshot.
  // The IDE is an agentic work surface: browser_* tools are expected alongside
  // repo intelligence, while Strict Mode separately guards native repo access.
  const managed = [
    ideServer,
    ...(cloudServer && cloudServer.name !== ideServer.name ? [cloudServer] : []),
    ...(browserServer ? [browserServer] : []),
  ];
  const managedNames = new Set(managed.map((server) => server.name));
  return [...existing.filter((server) => !managedNames.has(server.name)), ...managed];
};

/** Refresh persisted MCP snapshots before an existing conversation resumes. */
const refreshConversationMcpServers = async (
  conversation: TChatConversation,
  ideServer: ISessionMcpServer,
  memoryId: string,
  cloudServer?: ISessionMcpServer | null,
  browserServer?: ISessionMcpServer
): Promise<void> => {
  const extra = (conversation.extra ?? {}) as TChatConversation['extra'] & {
    session_mcp_servers?: ISessionMcpServer[];
    surface?: string;
    ide_memory_id?: string;
  };
  const existing = Array.isArray(extra.session_mcp_servers) ? extra.session_mcp_servers : [];
  const refreshed = mergeIdeSessionMcpServers(existing, ideServer, cloudServer, browserServer);
  const surfaceCurrent = extra.surface === 'ide' && extra.ide_memory_id === memoryId;
  if (surfaceCurrent && JSON.stringify(existing) === JSON.stringify(refreshed)) return;

  const updated = await ipcBridge.conversation.update.invoke({
    id: conversation.id,
    updates: {
      session_mcp_servers: refreshed,
      surface: 'ide',
      surface_version: 1,
      ide_memory_id: memoryId,
    } as never,
    merge_extra: true,
  });
  if (!updated) throw new Error(`Conversation ${conversation.id} rejected the IDE MCP refresh`);
};

/**
 * Manage the IDE's chat tab strip for a given workspace folder.
 *
 * @param rootPath - Absolute folder the IDE has open, or null when no folder
 *                   is selected (every action becomes a no-op).
 */
export const useIdeChat = (rootPath: string | null, options: IdeChatOptions = {}): UseIdeChat => {
  const [tabs, setTabs] = useState<IdeChatTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [planningEnabled, setPlanningEnabledState] = useState(false);
  const [creating, setCreating] = useState(false);
  const [syncRevision, setSyncRevision] = useState(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(
    () =>
      ipcBridge.conversation.listChanged.on((event) => {
        if (event.action === 'created' || event.action === 'deleted') {
          setSyncRevision((revision) => revision + 1);
        }
      }),
    []
  );

  // Restore tabs when a folder is opened: re-fetch each id and prune stale ones.
  useEffect(() => {
    if (!rootPath) {
      setTabs([]);
      setActiveId(null);
      setPlanningEnabledState(false);
      return;
    }
    setPlanningEnabledState(readPlanningEnabled(rootPath));
    const persisted = readPersistedTabs(rootPath);
    let cancelled = false;
    void Promise.all([resolveIdeMcpCatalog(), ipcBridge.database.getUserConversations.invoke({ limit: 200 })])
      .then(async ([mcpCatalog, result]) => {
        const discovered = (result?.items ?? [])
          .filter((conversation) => isConversationForIdeWorkspace(conversation, rootPath))
          .map((conversation): PersistedTab => {
            const extra = conversation.extra as { ide_memory_id?: string } | undefined;
            return { id: conversation.id, memId: extra?.ide_memory_id || newMemId() };
          });
        const seen = new Set<string>();
        const ids = [...persisted, ...discovered]
          .filter((record) => {
            if (seen.has(record.id)) return false;
            seen.add(record.id);
            return true;
          })
          .slice(-MAX_TABS);
        const entries = (
          await Promise.all(ids.map((rec) => getConversationOrNull(rec.id).catch((): null => null)))
        ).flatMap((conversation, index) => (conversation?.id ? [{ conversation, index }] : []));
        const refreshed = await Promise.allSettled(
          entries.map(({ conversation, index }) =>
            refreshConversationMcpServers(
              conversation,
              mcpCatalog.ideServer,
              ids[index]?.memId ?? newMemId(),
              options.cloudWorkspace?.remoteMcpServer ?? null,
              mcpCatalog.browserServer
            )
          )
        );
        if (cancelled || !aliveRef.current) return;
        refreshed.forEach((refreshResult, index) => {
          if (refreshResult.status === 'rejected') {
            console.warn(
              `[useIdeChat] MCP refresh failed for conversation ${entries[index]?.conversation.id ?? 'unknown'}:`,
              refreshResult.reason
            );
          }
        });
        const restored = entries.map(
          ({ conversation, index }): IdeChatTab => ({
            id: conversation.id,
            title: conversation.name ?? `Chat ${index + 1}`,
            memId: ids[index]?.memId ?? newMemId(),
          })
        );
        setTabs(restored);
        // A create/delete event also triggers this reconciliation. Do not reset
        // a valid user selection to the first tab while it is running.
        setActiveId((currentId) => resolveRestoredIdeChatActiveId(restored, currentId));
        writePersistedTabs(
          rootPath,
          restored.map((t) => ({ id: t.id, memId: t.memId }))
        );
      })
      .catch((error: unknown) => {
        console.error('[useIdeChat] restore failed:', error);
        if (!cancelled && aliveRef.current) {
          setTabs([]);
          setActiveId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [options.cloudWorkspace?.remoteMcpServer, rootPath, syncRevision]);

  const persist = useCallback(
    (next: IdeChatTab[]): void => {
      if (!rootPath) return;
      writePersistedTabs(
        rootPath,
        next.map((t) => ({ id: t.id, memId: t.memId }))
      );
    },
    [rootPath]
  );

  const open = useCallback(
    async (launcher: IdeChatLauncher): Promise<string | null> => {
      if (!rootPath || creating) return null;
      setCreating(true);
      try {
        const memId = newMemId();
        let params =
          launcher.kind === 'cli'
            ? await buildCliAgentParams(launcher.agent, rootPath)
            : await buildPresetAssistantParams(launcher.assistant, rootPath, launcher.language);
        const backend =
          launcher.kind === 'cli'
            ? resolveAgentBackendKey(launcher.agent)
            : launcher.assistant.preset_agent_type || 'claude';
        const strictMode = isStrictIdeModeEnabled(rootPath);
        if (strictMode) {
          const askMode = getAskMode(backend);
          if (!askMode) throw new Error(`Strict IDE Mode is not supported by backend ${backend}.`);
          params.extra.session_mode = askMode;
        }
        // Tab title: prefer the agent/assistant name (the conversation gets a
        // default name auto-derived later from history; we just need something
        // human in the strip).
        const tabTitle = launcher.kind === 'cli' ? launcher.agent.name : launcher.assistant.name;
        params.name = tabTitle;

        // ── IDE guide injection (best-effort, < 1s) ─────────────────────────
        // A new tab does not have a task yet, so do not rank/select files from
        // the KG here. Inject only the workspace operating guide + project
        // rules + the ephemeral session-memory binding; task-specific context is
        // built later from the user's message.
        try {
          const rulesResult = await ideClient.rulesLoad(rootPath).catch((): null => null);
          const rules = rulesResult?.ok ? rulesResult.data : [];
          const primer = buildWorkspacePrimer(rootPath, rules, planningEnabled, memId);
          const cloudGuide = options.cloudWorkspace ? buildCloudWorkspaceGuide(options.cloudWorkspace) : '';
          const injection = cloudGuide ? `${cloudGuide}\n\n${primer}` : primer;
          const existing = typeof params.extra?.preset_context === 'string' ? params.extra.preset_context : '';
          if (!params.extra) (params as unknown as Record<string, unknown>).extra = {};
          params.extra.preset_context = existing.length > 0 ? `${injection}\n\n${existing}` : injection;
        } catch {
          // Guide injection is best-effort — never block tab creation.
        }
        // ─────────────────────────────────────────────────────────────────────
        // The IDE MCP is mandatory for Studio chat: creating a session without it
        // would leave Strict Mode no valid replacement tools.
        const mcpCatalog = await resolveIdeMcpCatalog();
        const cloudServer = options.cloudWorkspace?.remoteMcpServer ?? null;
        const existing = Array.isArray(params.extra.selected_session_mcp_servers)
          ? params.extra.selected_session_mcp_servers
          : [];
        params.extra.selected_session_mcp_servers = mergeIdeSessionMcpServers(
          existing,
          mcpCatalog.ideServer,
          cloudServer,
          mcpCatalog.browserServer
        );
        params.extra.surface = 'ide';
        params.extra.surface_version = 1;
        params.extra.ide_memory_id = memId;
        params.extra.ide_planning_enabled = planningEnabled;
        const baseRules = withIdeMemoryRules(
          memId,
          withIdeToolRules(typeof params.extra.preset_rules === 'string' ? params.extra.preset_rules : '')
        );
        const cloudRules = options.cloudWorkspace ? buildCloudWorkspaceGuide(options.cloudWorkspace) : '';
        params.extra.preset_rules = cloudRules ? `${cloudRules}\n\n${baseRules}` : baseRules;
        const conv = await ipcBridge.conversation.create.invoke(params);
        if (!conv?.id) return null;
        if (strictMode) await enforceStrictIdeSessionMode(conv.id);
        // No visible "primer" turn: the session-memory binding rides the silent
        // rules/context layers above, so the chat opens clean and the agent just
        // greets the user instead of echoing a wall of setup text.
        //
        // Seed the tool-preference rule into this tab's session memory ONCE (a
        // pinned note) instead of appending a reminder to every message. The
        // agent recalls it on demand via `ide_memory_recall`, so the rule stays
        // available without polluting each turn with a noisy banner. Fire-and-
        // forget: a failure here never blocks the tab from opening.
        void ideClient.memoryRemember(memId, IDE_TOOL_PREFERENCE_NOTE, { kind: 'note', pinned: true }).catch(() => {
          // Memory seeding is best-effort — the Strict IDE Mode guard still
          // hard-enforces the tool remap regardless.
        });
        emitter.emit('chat.history.refresh');
        if (!aliveRef.current) return conv.id;
        const next: IdeChatTab[] = [...tabs, { id: conv.id, title: conv.name ?? tabTitle, memId }].slice(-MAX_TABS);
        setTabs(next);
        setActiveId(conv.id);
        persist(next);
        return conv.id;
      } catch (error) {
        console.error('[useIdeChat] open failed:', error);
        return null;
      } finally {
        if (aliveRef.current) setCreating(false);
      }
    },
    [creating, options.cloudWorkspace, persist, planningEnabled, rootPath, tabs]
  );

  const setActive = useCallback((id: string): void => {
    setActiveId((current) => (current === id ? current : id));
  }, []);

  const close = useCallback(
    async (id: string): Promise<void> => {
      // Optimistically remove from the strip + storage; the underlying
      // conversation is also deleted so it stops appearing in the global sidebar.
      const closing = tabs.find((t) => t.id === id);
      const next = tabs.filter((t) => t.id !== id);
      setTabs(next);
      persist(next);
      if (activeId === id) setActiveId(resolveIdeChatActiveIdAfterClose(tabs, id));
      // Wipe this tab's ephemeral session memory (close the tab → memory gone).
      if (closing?.memId) await ideClient.memoryClear(closing.memId).catch((): undefined => undefined);
      await ipcBridge.conversation.remove.invoke({ id }).catch((): undefined => undefined);
      emitter.emit('chat.history.refresh');
    },
    [activeId, persist, tabs]
  );

  const rename = useCallback(
    (id: string, title: string): void => {
      setTabs((prev) => {
        const next = prev.map((t) => (t.id === id ? { ...t, title } : t));
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const setPlanningEnabled = useCallback(
    (enabled: boolean): void => {
      setPlanningEnabledState(enabled);
      if (rootPath) {
        writePlanningEnabled(rootPath, enabled);
      }
    },
    [rootPath]
  );

  return { tabs, activeId, planningEnabled, creating, open, setActive, close, rename, setPlanningEnabled };
};

export default useIdeChat;
