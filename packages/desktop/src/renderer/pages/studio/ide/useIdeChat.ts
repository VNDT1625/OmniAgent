/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
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
import type { AgentMetadata } from '@/renderer/utils/model/agentTypes';
import { emitter } from '@/renderer/utils/emitter';
import {
  buildCliAgentParams,
  buildPresetAssistantParams,
} from '@/renderer/pages/conversation/utils/createConversationParams';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { ensureBackendMcpCatalog, toSessionMcpServer } from '@/renderer/hooks/mcp/catalog';
import { IDE_MCP_NAME, withIdeMemoryRules, withIdeToolRules } from '@/renderer/pages/conversation/hooks/superGuidance';
import type { ISessionMcpServer } from '@/common/config/storage';
import { ideClient } from './ideClient';

/** localStorage key for the per-repo tab id list. */
const STORAGE_PREFIX = 'studio.ide.chatTabs.';
/** localStorage key for the per-repo Planning Mode flag. */
const PLANNING_PREFIX = 'studio.ide.planning.';
/** Max tabs kept per repo (defensive — UI is fine with many). */
const MAX_TABS = 12;

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

/** What the caller picks when opening a new tab. */
export type IdeChatLauncher =
  | { kind: 'cli'; agent: AgentMetadata }
  | { kind: 'preset'; assistant: Assistant; language: string };

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
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `ide-mem-${crypto.randomUUID()}`;
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

/** Build the lightweight IDE primer injected when a tab opens without a task yet. */
const buildWorkspacePrimer = (rootPath: string, rules: readonly string[], planningEnabled: boolean, memId: string): string => {
  const sections = [
    [
      '## IDE workspace guide',
      `Workspace root: ${rootPath}`,
      'Use codegraph/wiki/search as a map; inspect source lazily only when the task needs it.',
      'MTUI runtime: use `mtui --json` for repo search/read/write/verify; check `diff --last` after writes.',
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
  // Bind this tab's ephemeral session super-memory so the agent can jot/recall
  // across turns without re-searching, and stash short-lived secrets.
  return withIdeMemoryRules(memId, sections.join('\n\n'));
};

/**
 * Resolve the built-in IDE MCP server (`aionui-ide`, an in-process SSE host
 * registered at boot) as a session-server snapshot, or null when unavailable.
 * Attaching it to an IDE chat tab is what actually gives the agent the `ide_*`
 * repo-intelligence tools AND the `ide_memory_*` session-memory tools.
 */
const resolveIdeMcp = async (): Promise<ISessionMcpServer | null> => {
  try {
    const { allServers } = await ensureBackendMcpCatalog();
    const server = allServers.find((s) => s.name === IDE_MCP_NAME);
    return server ? toSessionMcpServer(server) : null;
  } catch {
    return null;
  }
};

/**
 * Manage the IDE's chat tab strip for a given workspace folder.
 *
 * @param rootPath - Absolute folder the IDE has open, or null when no folder
 *                   is selected (every action becomes a no-op).
 */
export const useIdeChat = (rootPath: string | null): UseIdeChat => {
  const [tabs, setTabs] = useState<IdeChatTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [planningEnabled, setPlanningEnabledState] = useState(false);
  const [creating, setCreating] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Restore tabs when a folder is opened: re-fetch each id and prune stale ones.
  useEffect(() => {
    if (!rootPath) {
      setTabs([]);
      setActiveId(null);
      setPlanningEnabledState(false);
      return;
    }
    setPlanningEnabledState(readPlanningEnabled(rootPath));
    const ids = readPersistedTabs(rootPath);
    if (ids.length === 0) {
      setTabs([]);
      setActiveId(null);
      return;
    }
    let cancelled = false;
    void Promise.all(ids.map((rec) => getConversationOrNull(rec.id).catch((): null => null))).then((conversations) => {
      if (cancelled || !aliveRef.current) return;
      const restored: IdeChatTab[] = [];
      conversations.forEach((conv, i) => {
        if (conv && conv.id) {
          restored.push({ id: conv.id, title: conv.name ?? `Chat ${i + 1}`, memId: ids[i]?.memId ?? newMemId() });
        }
      });
      setTabs(restored);
      setActiveId(restored[0]?.id ?? null);
      // Prune stale ids from storage.
      writePersistedTabs(
        rootPath,
        restored.map((t) => ({ id: t.id, memId: t.memId }))
      );
    });
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

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
        const params =
          launcher.kind === 'cli'
            ? await buildCliAgentParams(launcher.agent, rootPath)
            : await buildPresetAssistantParams(launcher.assistant, rootPath, launcher.language);
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
          const injection = buildWorkspacePrimer(rootPath, rules, planningEnabled, memId);
          const existing = typeof params.extra?.preset_context === 'string' ? params.extra.preset_context : '';
          if (!params.extra) (params as unknown as Record<string, unknown>).extra = {};
          params.extra.preset_context = existing.length > 0 ? `${injection}\n\n${existing}` : injection;
        } catch {
          // Guide injection is best-effort — never block tab creation.
        }
        // ─────────────────────────────────────────────────────────────────────
        // Attach the built-in IDE MCP server (best-effort) so the agent actually
        // has the `ide_*` repo-intelligence tools and the `ide_memory_*` session
        // super-memory tools, then append the IDE tool rules to its rules layer.
        try {
          const ideServer = await resolveIdeMcp();
          if (ideServer) {
            if (!params.extra) (params as unknown as Record<string, unknown>).extra = {};
            const existing = Array.isArray(params.extra.selected_session_mcp_servers)
              ? params.extra.selected_session_mcp_servers
              : [];
            params.extra.selected_session_mcp_servers = [
              ...existing.filter((s) => s.name !== IDE_MCP_NAME),
              ideServer,
            ];
            params.extra.preset_rules = withIdeToolRules(
              typeof params.extra.preset_rules === 'string' ? params.extra.preset_rules : ''
            );
          }
        } catch {
          // Server attach is best-effort — never block tab creation.
        }
        const conv = await ipcBridge.conversation.create.invoke(params);
        if (!conv?.id) return null;
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
    [creating, persist, planningEnabled, rootPath, tabs]
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
      if (activeId === id) setActiveId(next[0]?.id ?? null);
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
