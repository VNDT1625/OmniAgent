/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `editorToolsProvider` — the RENDERER half of the editor-tools bridge.
 *
 * Registers a `bridge.provider` for {@link EDITOR_TOOLS_CHANNELS.run} so the
 * Office-editor MCP server (Main process) can drive the LIVE ONLYOFFICE editor
 * that only exists here. Main issues `invoke('editor-tools.run', { filePath,
 * action })`; this handler validates the action and dispatches it to
 * {@link onlyOfficeConnector} via the existing {@link runTool} dispatcher (the
 * same one the legacy in-renderer agent used), then returns a short observation.
 *
 * Mounted once for the app lifetime by {@link useEditorToolsProvider} (called
 * from the Studio app shell). The connector registry it talks to is a
 * module-level singleton keyed by `filePath`, so any open Office editor frame is
 * reachable regardless of which view registered the provider.
 *
 * Renderer-only. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import { useEffect } from 'react';
import {
  EDITOR_TOOLS_CHANNELS,
  type EditorToolRunRequest,
  type EditorToolRunResult,
} from '@process/editor/editorToolsBridge';
import { connectorKind, resolveConnectorPath } from '@renderer/pages/editor/adapters/onlyOfficeConnector';
import { parseAction, runTool } from './docAgentTools';

/** Typed provider channel (renderer registers the handler; Main invokes it). */
const channel = bridge.buildProvider<EditorToolRunResult, EditorToolRunRequest>(EDITOR_TOOLS_CHANNELS.run);

/** Whether the provider has been registered (module-level guard against double-mount). */
let registered = false;

/**
 * Register the editor-tools provider once. Idempotent — repeated calls are
 * no-ops, so multiple editor views can call it safely.
 */
export const registerEditorToolsProvider = (): void => {
  if (registered) return;
  registered = true;

  channel.provider(async (req: EditorToolRunRequest): Promise<EditorToolRunResult> => {
    const { filePath, action: rawAction } = req;

    // Tolerant match: the agent's filePath may differ from the registry key by
    // separator/case, or point at the same basename in another dir; also fall
    // back to the single open editor. Resolve to the real registered path.
    const resolved = resolveConnectorPath(filePath);
    if (!resolved) {
      return {
        ok: false,
        reason: 'not-ready',
        error:
          'The document is not open in "Edit (Office)" mode yet, so the editor tools are unavailable. Ask the user to open the document for editing, then retry.',
      };
    }

    const action = parseAction(rawAction);
    if (!action) {
      return { ok: false, reason: 'error', error: 'Invalid editor action payload.' };
    }
    if (action.tool === 'finish') {
      // 'finish' has no live-editor effect; treat as a no-op observation.
      return { ok: true, observation: action.summary || 'Done.', kind: connectorKind(resolved) };
    }

    const kind = connectorKind(resolved) ?? 'word';
    try {
      const { observation } = await runTool(resolved, kind, action);
      return { ok: true, observation, kind };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, reason: 'error', error: message };
    }
  });
};

/**
 * React hook that registers the editor-tools provider for the app lifetime.
 * Mount once high in the Studio tree (the registration is process-global and
 * idempotent, so it does not need to live on a specific editor view).
 */
export const useEditorToolsProvider = (): void => {
  useEffect(() => {
    registerEditorToolsProvider();
  }, []);
};
