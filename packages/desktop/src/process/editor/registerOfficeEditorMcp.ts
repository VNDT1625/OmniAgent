/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Start the in-process Office-editor MCP host and ensure the MCP catalog has an
 * `sse` entry pointing at its loopback URL — so the Studio editor chat (and any
 * agent) can attach it and edit the live document as MCP tools.
 *
 * Mirrors `process/automation/registerAutomationMcp.ts`. The catalog entry is
 * created `enabled: false` (opt-in): the editor chat adds it to that
 * conversation's `selected_session_mcp_servers` when starting. The loopback
 * port is ephemeral, so this registration is idempotent — it finds the existing
 * entry by name and refreshes its URL, or creates it.
 *
 * Called once after the backend is ready. Failures are swallowed/logged — a
 * registration problem must never block boot; the editor chat keeps working as
 * a plain chat (without the live-edit tools) regardless.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { mcpService } from '@/common/adapter/ipcBridge';
import { BUILTIN_OFFICE_EDITOR_NAME } from '../resources/builtinMcp/officeEditorServer';
import { startOfficeEditor } from './officeEditorMcpWiring';

/** Human-readable description shown for the Office-editor MCP server in the catalog. */
const OFFICE_EDITOR_MCP_DESCRIPTION =
  'Edit the document open in the Studio editor with fast, formatting-preserving tools: read, ' +
  'search & replace, replace/format a passage, insert text/tables/TOC, set spreadsheet cells, ' +
  'and run any ONLYOFFICE Document Builder API script. Drives the live editor the user is watching.';

/**
 * Start the host and register/refresh its `sse` entry in the MCP catalog.
 *
 * @returns `true` when the catalog reflects the running host, `false` on any
 *   handled failure (logged, non-fatal — the editor chat still works).
 */
export const ensureOfficeEditorMcpRegistered = async (): Promise<boolean> => {
  try {
    const host = await startOfficeEditor();

    const transport = { type: 'sse' as const, url: host.url };
    const original_json = JSON.stringify({ mcpServers: { [BUILTIN_OFFICE_EDITOR_NAME]: { url: host.url } } }, null, 2);

    const existing = (await mcpService.listServers.invoke()) ?? [];
    const current = existing.find((server) => server.name === BUILTIN_OFFICE_EDITOR_NAME);

    if (!current) {
      await mcpService.batchImportServers.invoke({
        servers: [
          {
            name: BUILTIN_OFFICE_EDITOR_NAME,
            description: OFFICE_EDITOR_MCP_DESCRIPTION,
            enabled: false,
            builtin: true,
            transport,
            original_json,
          },
        ],
      });
      console.log(`[OfficeEditorMCP] Registered "${BUILTIN_OFFICE_EDITOR_NAME}" at ${host.url}.`);
      return true;
    }

    const sameUrl = current.transport.type === 'sse' && current.transport.url === host.url;
    if (!sameUrl) {
      await mcpService.updateServer.invoke({
        id: current.id,
        data: { transport, original_json, builtin: true },
      });
      console.log(`[OfficeEditorMCP] Updated "${BUILTIN_OFFICE_EDITOR_NAME}" URL → ${host.url}.`);
    }
    return true;
  } catch (error) {
    console.warn('[OfficeEditorMCP] Could not register the Office-editor MCP server (editor chat still works):', error);
    return false;
  }
};
