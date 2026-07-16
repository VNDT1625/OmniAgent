/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Start the in-process Automation MCP host and ensure the MCP catalog has an
 * `sse` entry pointing at its loopback URL — so an agent (Claude Code / ACP,
 * aionrs, …) can create, run, and manage n8n-style workflows as tools.
 *
 * Mirrors `process/cron/registerCronMcp.ts`. The catalog entry is created
 * `enabled: false` (opt-in per conversation via the MCP picker / "Super"
 * surface). The loopback port is ephemeral, so this registration is idempotent:
 * it finds the existing entry by name and refreshes its URL, or creates it.
 *
 * Called once after the backend is ready. Failures are swallowed/logged — a
 * registration problem must never block boot, and the Automation UI keeps
 * working regardless.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { mcpService } from '@/common/adapter/ipcBridge';
import { BUILTIN_AUTOMATION_NAME } from './automationMcpServer';
import { startAutomation } from './automationMcpWiring';

/** Human-readable description shown for the Automation MCP server in the catalog. */
const AUTOMATION_MCP_DESCRIPTION =
  'Create, run, and manage n8n-style automation workflows: list, inspect, create from a node spec, ' +
  'run, cancel, enable/disable, and delete workflows. Shares state with the Automation page.';

/**
 * Start the host and register/refresh its `sse` entry in the MCP catalog.
 *
 * @returns `true` when the catalog reflects the running host, `false` on any
 *   handled failure (logged, non-fatal — the UI plane still works).
 */
export const ensureAutomationMcpRegistered = async (): Promise<boolean> => {
  try {
    const host = await startAutomation();

    const transport = { type: 'sse' as const, url: host.url };
    const original_json = JSON.stringify({ mcpServers: { [BUILTIN_AUTOMATION_NAME]: { url: host.url } } }, null, 2);

    const existing = (await mcpService.listServers.invoke()) ?? [];
    const current = existing.find((server) => server.name === BUILTIN_AUTOMATION_NAME);

    if (!current) {
      await mcpService.batchImportServers.invoke({
        servers: [
          {
            name: BUILTIN_AUTOMATION_NAME,
            description: AUTOMATION_MCP_DESCRIPTION,
            enabled: false,
            builtin: true,
            transport,
            original_json,
          },
        ],
      });
      console.log(`[AutomationMCP] Registered "${BUILTIN_AUTOMATION_NAME}" at ${host.url}.`);
      return true;
    }

    const sameUrl = current.transport.type === 'sse' && current.transport.url === host.url;
    if (!sameUrl) {
      await mcpService.updateServer.invoke({
        id: current.id,
        data: { transport, original_json, builtin: true },
      });
      console.log(`[AutomationMCP] Updated "${BUILTIN_AUTOMATION_NAME}" URL → ${host.url}.`);
    }
    return true;
  } catch (error) {
    console.warn('[AutomationMCP] Could not register the Automation MCP server (UI plane still works):', error);
    return false;
  }
};
