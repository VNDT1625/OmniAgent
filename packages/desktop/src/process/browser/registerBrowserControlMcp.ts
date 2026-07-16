/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Start the in-process Browser-Control MCP host and ensure the MCP catalog has
 * an `sse` server entry pointing at its loopback URL — so an agent (Claude Code
 * / ACP, aionrs, …) can connect and drive the live embedded browser.
 *
 * Mirrors `process/testing/registerTestingMcp.ts`. The catalog entry is created
 * `enabled: false` (not auto-attached to every new chat): it is the
 * per-conversation **"Super"** toggle that opts a conversation into this server
 * (the renderer adds it to that conversation's `selected_session_mcp_servers`).
 * Registering it makes it *available*; enabling it per-chat is the user's call.
 *
 * Process boundary: Main-process (Node.js / Electron) module.
 */

import { mcpService } from '@/common/adapter/ipcBridge';
import { BUILTIN_BROWSER_CONTROL_NAME } from '../resources/builtinMcp/browserControlServer';
import { getApplicationMainWindow } from '../bridge/applicationBridge';
import { startBrowserControl } from './browserControlWiring';

/** Human description shown in the MCP catalog / tools picker. */
const BROWSER_CONTROL_MCP_DESCRIPTION =
  'Drive a live embedded browser: open pages, read/click/type/scroll, wait, screenshot and summarise video. ' +
  'Lets the chat agent operate the web on your behalf (the "Super" capability). Shares tabs with the in-app browser.';

/**
 * Start the host and register/refresh its `sse` entry in the MCP catalog.
 *
 * @returns `true` when the catalog reflects the running host, `false` on any
 *   handled failure (logged, non-fatal — the UI plane still works).
 */
export const ensureBrowserControlMcpRegistered = async (): Promise<boolean> => {
  try {
    const host = await startBrowserControl(getApplicationMainWindow);

    const transport = { type: 'sse' as const, url: host.url };
    const original_json = JSON.stringify(
      { mcpServers: { [BUILTIN_BROWSER_CONTROL_NAME]: { url: host.url } } },
      null,
      2
    );

    const existing = (await mcpService.listServers.invoke()) ?? [];
    const current = existing.find((server) => server.name === BUILTIN_BROWSER_CONTROL_NAME);

    if (!current) {
      await mcpService.batchImportServers.invoke({
        servers: [
          {
            name: BUILTIN_BROWSER_CONTROL_NAME,
            description: BROWSER_CONTROL_MCP_DESCRIPTION,
            // Available but not auto-attached: the per-conversation "Super"
            // toggle opts a chat in. Default-off avoids surprising every new chat.
            enabled: false,
            builtin: true,
            transport,
            original_json,
          },
        ],
      });
      console.log(`[BrowserControlMCP] Registered "${BUILTIN_BROWSER_CONTROL_NAME}" at ${host.url}.`);
      return true;
    }

    // Refresh the URL if the ephemeral port changed since the last boot.
    const sameUrl = current.transport.type === 'sse' && current.transport.url === host.url;
    if (!sameUrl) {
      await mcpService.updateServer.invoke({
        id: current.id,
        data: { transport, original_json, builtin: true },
      });
      console.log(`[BrowserControlMCP] Updated "${BUILTIN_BROWSER_CONTROL_NAME}" URL → ${host.url}.`);
    }
    return true;
  } catch (error) {
    console.warn(
      '[BrowserControlMCP] Could not register the Browser-Control MCP server (UI plane still works):',
      error
    );
    return false;
  }
};
