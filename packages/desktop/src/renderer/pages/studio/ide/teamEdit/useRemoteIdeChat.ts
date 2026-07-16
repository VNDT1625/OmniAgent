/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Remote peer chat tabs backed by the main conversation system. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import { STRICT_IDE_CLAUDE_AGENT_NAME } from '@/common/chat/approval/ideToolGuard';
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
import type { PeerConnection } from './useTeamCollab';

type RemoteIdeConnection = Omit<PeerConnection, 'peerCapabilities'>;

export type RemoteIdeChatTab = { id: string; title: string };

export type RemoteIdeChatLauncher =
  | { kind: 'cli'; agent: AgentMetadata }
  | { kind: 'preset'; assistant: Assistant; language: string };

export type UseRemoteIdeChat = {
  tabs: RemoteIdeChatTab[];
  activeId: string | null;
  creating: boolean;
  open: (launcher: RemoteIdeChatLauncher) => Promise<string | null>;
  setActive: (id: string) => void;
  close: (id: string) => Promise<void>;
  rename: (id: string, title: string) => void;
};

const STORAGE_PREFIX = 'studio.ide.remoteChatTabs.';
const MAX_TABS = 8;

const storageKey = (peer: RemoteIdeConnection): string => `${STORAGE_PREFIX}${peer.baseUrl}|${peer.repoName}`;

const readStoredTabs = (peer: RemoteIdeConnection): RemoteIdeChatTab[] => {
  try {
    const raw = localStorage.getItem(storageKey(peer));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const value = item as { id?: unknown; title?: unknown };
        return typeof value.id === 'string' ? { id: value.id, title: String(value.title || value.id) } : null;
      })
      .filter((item): item is RemoteIdeChatTab => item !== null);
  } catch {
    return [];
  }
};

const writeStoredTabs = (peer: RemoteIdeConnection, tabs: RemoteIdeChatTab[]): void => {
  try {
    localStorage.setItem(storageKey(peer), JSON.stringify(tabs));
  } catch {
    // Ignore storage quota/private-mode failures.
  }
};

const buildRemoteRules = (peer: RemoteIdeConnection): string => {
  const cloudPeer = peer as RemoteIdeConnection & { relayBaseUrl?: string; workspaceId?: string };
  const isCloud = typeof cloudPeer.relayBaseUrl === 'string' && cloudPeer.relayBaseUrl.length > 0;
  return [
    isCloud
      ? `You are connected to an AionUi CLOUD workspace named "${cloudPeer.workspaceId || peer.repoName}".`
      : `You are connected to a REMOTE AionUi team workspace named "${peer.repoName}".`,
    `Your local cwd is a scratch launcher folder: ${peer.workspacePath}. It is not the repository.`,
    isCloud
      ? `The cloud relay is the repository source of truth: ${cloudPeer.relayBaseUrl}.`
      : 'The host AionUi app is the repository source of truth.',
    'Use only the attached aionui-remote-ide MCP tools for repository work.',
    'Use repo-relative paths. Examples: `package.json`, `packages/desktop/src/main.ts`.',
    'Read/list/search with `ide_list_dir`, `ide_glob`, `ide_read_file`, `ide_search`, `ide_grep`, `ide_find_definition`, and `ide_find_references`.',
    'Analyze/navigate with `ide_scan_repo`, `ide_summary`, `ide_info`, `ide_compass`, `ide_context`, `ide_map`, `ide_analyze`, and `ide_compact`.',
    isCloud
      ? '`ide_command` is available for tests/builds; it materializes a temporary cloud worktree cache and does not persist cache edits.'
      : '`ide_command` is disabled in remote team mode to protect the host.',
    'Edit with `team_edit_file` for targeted replacements or `team_write_file` for whole-file writes.',
    isCloud
      ? 'Cloud edits are appended to the cloud operation log and become visible to every connected machine.'
      : 'Host load is protected by a queue; keep searches bounded with dir/glob/maxResults.',
    'Do not use native shell/filesystem tools to inspect or modify this remote repository.',
  ].join('\n');
};

export const useRemoteIdeChat = (peer: RemoteIdeConnection): UseRemoteIdeChat => {
  const [tabs, setTabs] = useState<RemoteIdeChatTab[]>(() => readStoredTabs(peer));
  const [activeId, setActiveId] = useState<string | null>(() => readStoredTabs(peer)[0]?.id ?? null);
  const [creating, setCreating] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const stored = readStoredTabs(peer);
    void Promise.all(stored.map(async (tab) => ((await getConversationOrNull(tab.id)) ? tab : null))).then((items) => {
      if (cancelled || !aliveRef.current) return;
      const next = items.filter((item): item is RemoteIdeChatTab => item !== null);
      setTabs(next);
      setActiveId(next[0]?.id ?? null);
      writeStoredTabs(peer, next);
    });
    return () => {
      cancelled = true;
    };
  }, [peer]);

  const persist = useCallback(
    (next: RemoteIdeChatTab[]): void => {
      writeStoredTabs(peer, next);
    },
    [peer]
  );

  const open = useCallback(
    async (launcher: RemoteIdeChatLauncher): Promise<string | null> => {
      if (creating) return null;
      setCreating(true);
      try {
        let params =
          launcher.kind === 'cli'
            ? await buildCliAgentParams(launcher.agent, peer.workspacePath)
            : await buildPresetAssistantParams(launcher.assistant, peer.workspacePath, launcher.language);
        const backend =
          launcher.kind === 'cli'
            ? resolveAgentBackendKey(launcher.agent)
            : launcher.assistant.preset_agent_type || 'claude';
        if (backend === 'claude') {
          const agents = await ipcBridge.acpConversation.getAvailableAgents.invoke();
          const strictAgent = agents.find(
            (agent) => agent.name === STRICT_IDE_CLAUDE_AGENT_NAME && agent.agent_source === 'custom' && agent.available
          );
          if (strictAgent) {
            const strictParams = await buildCliAgentParams(strictAgent, peer.workspacePath);
            params = { ...strictParams, name: params.name, extra: { ...params.extra, ...strictParams.extra } };
          }
        }
        if (!params.extra) (params as unknown as { extra: Record<string, unknown> }).extra = {};
        const existingContext = typeof params.extra.preset_context === 'string' ? params.extra.preset_context : '';
        const existingRules = typeof params.extra.preset_rules === 'string' ? params.extra.preset_rules : '';
        const remoteRules = buildRemoteRules(peer);
        params.extra.preset_context = existingContext ? `${remoteRules}\n\n${existingContext}` : remoteRules;
        params.extra.preset_rules = existingRules ? `${remoteRules}\n\n${existingRules}` : remoteRules;
        params.extra.session_mode = getAskMode(backend);
        params.extra.selected_session_mcp_servers = [peer.remoteMcpServer];
        params.name = launcher.kind === 'cli' ? launcher.agent.name : launcher.assistant.name;
        const conv = await ipcBridge.conversation.create.invoke(params);
        if (!conv?.id) return null;
        emitter.emit('chat.history.refresh');
        if (!aliveRef.current) return conv.id;
        const next = [...tabs, { id: conv.id, title: conv.name ?? params.name ?? conv.id }].slice(-MAX_TABS);
        setTabs(next);
        setActiveId(conv.id);
        persist(next);
        return conv.id;
      } catch (error) {
        console.error('[useRemoteIdeChat] open failed:', error);
        return null;
      } finally {
        if (aliveRef.current) setCreating(false);
      }
    },
    [creating, peer, persist, tabs]
  );

  const setActive = useCallback((id: string): void => setActiveId(id), []);

  const close = useCallback(
    async (id: string): Promise<void> => {
      const next = tabs.filter((tab) => tab.id !== id);
      setTabs(next);
      persist(next);
      if (activeId === id) setActiveId(next[0]?.id ?? null);
      await ipcBridge.conversation.remove.invoke({ id }).catch((): undefined => undefined);
      emitter.emit('chat.history.refresh');
    },
    [activeId, persist, tabs]
  );

  const rename = useCallback(
    (id: string, title: string): void => {
      setTabs((prev) => {
        const next = prev.map((tab) => (tab.id === id ? { ...tab, title } : tab));
        persist(next);
        return next;
      });
    },
    [persist]
  );

  return { tabs, activeId, creating, open, setActive, close, rename };
};
