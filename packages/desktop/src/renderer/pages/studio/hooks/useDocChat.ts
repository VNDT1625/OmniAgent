/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useDocChat` — single-conversation chat for the Studio editor's AI panel.
 *
 * Replaces the previous bespoke `DocAssistantPanel` engines (`useDocAssistant`
 * one-shot completion + `useDocAgent` hand-rolled ReAct loop) with the MAIN
 * conversation/CLI-agent system: the panel embeds a real `<ChatConversation>`
 * (the same component the routed `/conversation/:id` page renders), so the
 * editor's assistant is functionally identical to the main chat — streaming,
 * markdown, preview, full CLI-agent tool use, history.
 *
 * Mirrors {@link useIdeChat} but keeps exactly ONE conversation per open file:
 * the conversation is pinned to the file's parent directory
 * (`extra.workspace`), so a CLI agent (Claude Code / Codex / Gemini …) runs
 * with that folder as its cwd and can read/write the file. The conversation id
 * is persisted per `filePath` so reopening the same file restores the chat.
 *
 * When the built-in Office-editor MCP server is registered (boot), it is
 * attached to the conversation's `selected_session_mcp_servers` so the agent
 * can edit the LIVE document with fast, formatting-preserving tools (and falls
 * back to plain read/write by path otherwise). Attachment is best-effort:
 * a missing catalog entry never blocks chat.
 *
 * Renderer-only: talks to Main via `ipcBridge.conversation.create/remove` and
 * the shared MCP catalog; no Node.js APIs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import type { ISessionMcpServer } from '@/common/config/storage';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { AgentMetadata } from '@/renderer/utils/model/agentTypes';
import { emitter } from '@/renderer/utils/emitter';
import {
  buildCliAgentParams,
  buildPresetAssistantParams,
} from '@/renderer/pages/conversation/utils/createConversationParams';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { ensureBackendMcpCatalog, toSessionMcpServer } from '@/renderer/hooks/mcp/catalog';
import { OFFICE_EDITOR_MCP_NAME, withOfficeEditorRules } from './officeEditorGuidance';

/** localStorage key prefix mapping an open file → its chat conversation id. */
const STORAGE_PREFIX = 'studio.docChat.';

/** What the caller picks when starting the editor chat. */
export type DocChatLauncher =
  | { kind: 'cli'; agent: AgentMetadata }
  | { kind: 'preset'; assistant: Assistant; language: string };

/** Public shape returned by {@link useDocChat}. */
export type UseDocChat = {
  /** The conversation id backing the chat, or null before one is started. */
  conversationId: string | null;
  /** Whether a create call is in flight (UI shows a spinner). */
  creating: boolean;
  /** Whether the persisted conversation is being restored on mount. */
  restoring: boolean;
  /** Start a chat for the open file, pinned to its folder. Returns the id. */
  open: (launcher: DocChatLauncher) => Promise<string | null>;
  /** Discard the current chat (deletes the conversation) and reset to empty. */
  reset: () => Promise<void>;
};

/** Derive the parent directory of a file path (workspace for the agent). */
const parentDirOf = (filePath: string): string => {
  const norm = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const slash = norm.lastIndexOf('/');
  // No separator → fall back to the path itself (degenerate, but safe).
  return slash > 0 ? norm.slice(0, slash) : norm;
};

/** Read the persisted conversation id for `filePath` (best-effort). */
const readPersisted = (filePath: string): string | null => {
  try {
    return localStorage.getItem(STORAGE_PREFIX + filePath);
  } catch {
    return null;
  }
};

/** Persist (or clear) the conversation id for `filePath` (best-effort). */
const writePersisted = (filePath: string, id: string | null): void => {
  try {
    if (id) localStorage.setItem(STORAGE_PREFIX + filePath, id);
    else localStorage.removeItem(STORAGE_PREFIX + filePath);
  } catch {
    /* localStorage unavailable / quota — non-fatal */
  }
};

/**
 * Locate the built-in Office-editor MCP server in the catalog (registered at
 * boot) and return it as a session-server snapshot, or null when unavailable.
 */
const resolveOfficeMcp = async (): Promise<ISessionMcpServer | null> => {
  try {
    const { allServers } = await ensureBackendMcpCatalog();
    const server = allServers.find((s) => s.name === OFFICE_EDITOR_MCP_NAME);
    return server ? toSessionMcpServer(server) : null;
  } catch {
    return null;
  }
};

/**
 * Manage the editor's single chat conversation for one open file.
 *
 * @param filePath - Absolute path of the open document (keys the chat).
 */
export const useDocChat = (filePath: string): UseDocChat => {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Restore the persisted conversation for this file (prune if it's gone).
  useEffect(() => {
    setRestoring(true);
    setConversationId(null);
    const persisted = readPersisted(filePath);
    if (!persisted) {
      setRestoring(false);
      return;
    }
    let cancelled = false;
    void getConversationOrNull(persisted)
      .catch((): null => null)
      .then((conv) => {
        if (cancelled || !aliveRef.current) return;
        if (conv?.id) {
          setConversationId(conv.id);
        } else {
          writePersisted(filePath, null);
        }
        setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const open = useCallback(
    async (launcher: DocChatLauncher): Promise<string | null> => {
      if (creating || conversationId) return conversationId;
      setCreating(true);
      try {
        const workspace = parentDirOf(filePath);
        const params =
          launcher.kind === 'cli'
            ? await buildCliAgentParams(launcher.agent, workspace)
            : await buildPresetAssistantParams(launcher.assistant, workspace, launcher.language);
        params.name = launcher.kind === 'cli' ? launcher.agent.name : launcher.assistant.name;

        // Attach the Office-editor MCP (best-effort) + append standing rules so
        // the agent uses the fast office_* tools on the live document.
        const officeServer = await resolveOfficeMcp();
        if (officeServer) {
          if (!params.extra) (params as unknown as Record<string, unknown>).extra = {};
          const existing = Array.isArray(params.extra.selected_session_mcp_servers)
            ? params.extra.selected_session_mcp_servers
            : [];
          params.extra.selected_session_mcp_servers = [
            ...existing.filter((s) => s.name !== OFFICE_EDITOR_MCP_NAME),
            officeServer,
          ];
          params.extra.preset_rules = withOfficeEditorRules(params.extra.preset_rules, filePath);
        }

        const conv = await ipcBridge.conversation.create.invoke(params);
        if (!conv?.id) return null;
        emitter.emit('chat.history.refresh');
        if (!aliveRef.current) return conv.id;
        setConversationId(conv.id);
        writePersisted(filePath, conv.id);
        return conv.id;
      } catch (error) {
        console.error('[useDocChat] open failed:', error);
        return null;
      } finally {
        if (aliveRef.current) setCreating(false);
      }
    },
    [conversationId, creating, filePath]
  );

  const reset = useCallback(async (): Promise<void> => {
    const id = conversationId;
    setConversationId(null);
    writePersisted(filePath, null);
    if (id) {
      await ipcBridge.conversation.remove.invoke({ id }).catch((): undefined => undefined);
      emitter.emit('chat.history.refresh');
    }
  }, [conversationId, filePath]);

  return { conversationId, creating, restoring, open, reset };
};

export default useDocChat;
