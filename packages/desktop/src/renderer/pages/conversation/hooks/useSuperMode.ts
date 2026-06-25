/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useSuperMode` — the per-conversation "Super" switch.
 *
 * When Super is ON, the conversation's agent (Claude Code / ACP, aionrs, …) is
 * granted the **Browser-Control** tool set (open a live browser tab, read/click/
 * type/scroll, screenshot, …) so it can decide, on its own, to drive the web on
 * the user's behalf — exactly the "agent tự dùng khung sống khi cần" behaviour.
 *
 * Mechanically this attaches/detaches the built-in `aionui-browser-control` MCP
 * server (an in-process SSE host, registered at boot) to the conversation by
 * updating `conversation.extra.session_mcp_servers`. The agent picks up the new
 * tools on its next turn. The preference is remembered per conversation in
 * `localStorage` so the toggle reflects the last choice when reopening a chat.
 *
 * Renderer-only module: talks to the Main process via `mcpService` (HTTP) and
 * `ipcBridge.conversation.update`; no Node.js APIs.
 */

import { ipcBridge } from '@/common';
import type { IMcpServer, ISessionMcpServer } from '@/common/config/storage';
import { ensureBackendMcpCatalog, toSessionMcpServer } from '@/renderer/hooks/mcp/catalog';
import { useCallback, useEffect, useState } from 'react';
import { BROWSER_CONTROL_MCP_NAME, withSuperBrowserRules } from './superGuidance';

/** Canonical name of the built-in Browser-Control MCP server (re-exported for callers). */
export { BROWSER_CONTROL_MCP_NAME };

/** `localStorage` key prefix remembering the Super toggle per conversation. */
const SUPER_KEY_PREFIX = 'aionui.super.';

/** Read the remembered Super state for a conversation (best-effort). */
const loadSuper = (conversationId: string): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(`${SUPER_KEY_PREFIX}${conversationId}`) === '1';
  } catch {
    return false;
  }
};

/** Persist the Super state for a conversation (best-effort). */
const saveSuper = (conversationId: string, on: boolean): void => {
  if (typeof window === 'undefined') return;
  try {
    if (on) window.localStorage.setItem(`${SUPER_KEY_PREFIX}${conversationId}`, '1');
    else window.localStorage.removeItem(`${SUPER_KEY_PREFIX}${conversationId}`);
  } catch {
    // Non-critical.
  }
};

/** Status of the Super capability for the current conversation. */
export type SuperStatus = 'unavailable' | 'off' | 'on' | 'pending';

/** Public shape returned by {@link useSuperMode}. */
export type UseSuperMode = {
  /** Whether the Browser-Control server exists in the catalog (registered at boot). */
  available: boolean;
  /** Whether Super is currently ON for this conversation. */
  enabled: boolean;
  /** Whether an attach/detach is in flight. */
  pending: boolean;
  /** The most recent error message, or null. */
  error: string | null;
  /** Turn Super on/off; attaches/detaches the Browser-Control MCP server. */
  toggle: (next: boolean) => Promise<void>;
};

/**
 * Manage the Super capability for one conversation.
 *
 * @param conversationId The conversation to toggle Super on (undefined → no-op).
 */
export function useSuperMode(conversationId: string | undefined): UseSuperMode {
  const [server, setServer] = useState<IMcpServer | null>(null);
  const [enabled, setEnabled] = useState<boolean>(() => (conversationId ? loadSuper(conversationId) : false));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Locate the Browser-Control server in the catalog (registered at boot).
  useEffect(() => {
    let alive = true;
    void ensureBackendMcpCatalog()
      .then(({ allServers }) => {
        if (!alive) return;
        setServer(allServers.find((s) => s.name === BROWSER_CONTROL_MCP_NAME) ?? null);
      })
      .catch(() => {
        if (alive) setServer(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Re-sync from the conversation's ACTUAL attached servers — this is the source
  // of truth, not localStorage. A chat can be created with Super already ON (the
  // new-chat screen adds the Browser-Control server to its session servers), in
  // which case there is no localStorage flag yet; reading the conversation makes
  // the switch reflect reality on entry (and on another device / after a reload).
  // The remembered preference is shown optimistically while the read is in flight.
  //
  // IMPORTANT (stale-URL fix): the Browser-Control MCP host binds an EPHEMERAL
  // loopback port that changes every app restart. The conversation snapshots the
  // server (incl. its URL) into `session_mcp_servers` at toggle time, so after a
  // restart that snapshot points at a DEAD port → aioncore can't connect → the
  // agent sees no tools and calls `browser_open` → "Unknown tool". To fix it we
  // re-write the attached server from the LIVE catalog entry (kept current at
  // boot by registerBrowserControlMcp) whenever its transport differs.
  useEffect(() => {
    if (!conversationId) {
      setEnabled(false);
      setError(null);
      return;
    }
    setEnabled(loadSuper(conversationId));
    setError(null);
    let alive = true;
    void ipcBridge.conversation.get
      .invoke({ id: conversationId })
      .then(async (conv) => {
        if (!alive) return;
        const extra = (conv?.extra ?? {}) as { session_mcp_servers?: ISessionMcpServer[] };
        const servers = Array.isArray(extra.session_mcp_servers) ? extra.session_mcp_servers : [];
        const attachedEntry = servers.find((s) => s.name === BROWSER_CONTROL_MCP_NAME) ?? null;
        const attached = Boolean(attachedEntry);
        setEnabled(attached);
        saveSuper(conversationId, attached);

        // Refresh a stale loopback URL so the agent reconnects after a restart.
        if (attached && server) {
          const fresh: ISessionMcpServer = toSessionMcpServer(server);
          const stale = JSON.stringify(attachedEntry?.transport) !== JSON.stringify(fresh.transport);
          if (stale) {
            const rebuilt = servers.map((s) => (s.name === BROWSER_CONTROL_MCP_NAME ? fresh : s));
            await ipcBridge.conversation.update
              .invoke({
                id: conversationId,
                updates: { session_mcp_servers: rebuilt } as never,
                merge_extra: true,
              })
              .catch((): boolean => false);
          }
        }
      })
      .catch(() => {
        // Keep the optimistic localStorage value on read failure.
      });
    return () => {
      alive = false;
    };
  }, [conversationId, server]);

  const toggle = useCallback(
    async (next: boolean) => {
      if (!conversationId || !server) return;
      setPending(true);
      setError(null);
      try {
        const session: ISessionMcpServer = toSessionMcpServer(server);
        // Read the conversation's current session servers, then add/remove ours.
        const current = await ipcBridge.conversation.get.invoke({ id: conversationId }).catch((): null => null);
        const extra = (current?.extra ?? {}) as {
          session_mcp_servers?: ISessionMcpServer[];
          preset_rules?: string;
        };
        const existing = Array.isArray(extra.session_mcp_servers) ? extra.session_mcp_servers : [];
        const without = existing.filter((s) => s.name !== BROWSER_CONTROL_MCP_NAME);
        const updatedServers = next ? [...without, session] : without;

        // When turning Super ON, append the standing browser rules so the agent
        // uses the embedded `browser_*` tools instead of spawning sub-agents or
        // shelling out to the OS (`start`/`open`) — which fails and has no tools.
        const updates: { session_mcp_servers: ISessionMcpServer[]; preset_rules?: string } = {
          session_mcp_servers: updatedServers,
        };
        if (next) updates.preset_rules = withSuperBrowserRules(extra.preset_rules);

        const ok = await ipcBridge.conversation.update.invoke({
          id: conversationId,
          updates: updates as never,
          merge_extra: true,
        });
        if (!ok) throw new Error('The conversation could not be updated.');

        setEnabled(next);
        saveSuper(conversationId, next);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(false);
      }
    },
    [conversationId, server]
  );

  return {
    available: Boolean(server),
    enabled,
    pending,
    error,
    toggle,
  };
}
