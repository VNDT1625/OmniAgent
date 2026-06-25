/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Start the in-process Cron MCP host and ensure the MCP catalog has an `sse`
 * server entry pointing at its loopback URL — so an agent (Claude Code / ACP,
 * aionrs, …) can connect and manage the user's scheduled tasks as tools.
 *
 * Mirrors `process/testing/registerTestingMcp.ts` and
 * `process/browser/registerBrowserControlMcp.ts`. The catalog entry is created
 * `enabled: false` (not auto-attached to every new chat): it is opt-in per
 * conversation through the MCP picker / the "Super" capability surface. The
 * loopback port is ephemeral (changes each boot), so this registration is
 * idempotent: it finds the existing catalog entry by name and refreshes its URL,
 * or creates it the first time.
 *
 * Called once after the backend is ready (from `runBackendMigrations`). Failures
 * are swallowed/logged — a registration problem must never block boot, and the
 * UI plane (the Scheduled Tasks page) keeps working regardless.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { mcpService } from '@/common/adapter/ipcBridge';
import { BUILTIN_CRON_NAME } from '../resources/builtinMcp/constants';
import { startCron } from './cronWiring';

/** Human-readable description shown for the Cron MCP server in the catalog. */
const CRON_MCP_DESCRIPTION =
  "Manage the user's scheduled tasks (cron jobs): list, inspect, create, update, pause/resume, " +
  'run-now and delete tasks that run a prompt on a schedule. Shares state with the Scheduled Tasks page.';

/**
 * Start the host and register/refresh its `sse` entry in the MCP catalog.
 *
 * @returns `true` when the catalog reflects the running host, `false` on any
 *   handled failure (logged, non-fatal — the UI plane still works).
 */
export const ensureCronMcpRegistered = async (): Promise<boolean> => {
  try {
    const host = await startCron();

    const transport = { type: 'sse' as const, url: host.url };
    const original_json = JSON.stringify({ mcpServers: { [BUILTIN_CRON_NAME]: { url: host.url } } }, null, 2);

    const existing = (await mcpService.listServers.invoke()) ?? [];
    const current = existing.find((server) => server.name === BUILTIN_CRON_NAME);

    if (!current) {
      await mcpService.batchImportServers.invoke({
        servers: [
          {
            name: BUILTIN_CRON_NAME,
            description: CRON_MCP_DESCRIPTION,
            // Available but not auto-attached: opt a chat in via the MCP picker
            // / "Super" surface. Default-off avoids surprising every new chat.
            enabled: false,
            builtin: true,
            transport,
            original_json,
          },
        ],
      });
      console.log(`[CronMCP] Registered "${BUILTIN_CRON_NAME}" at ${host.url}.`);
      return true;
    }

    // Refresh the URL if the ephemeral port changed since the last boot.
    const sameUrl = current.transport.type === 'sse' && current.transport.url === host.url;
    if (!sameUrl) {
      await mcpService.updateServer.invoke({
        id: current.id,
        data: { transport, original_json, builtin: true },
      });
      console.log(`[CronMCP] Updated "${BUILTIN_CRON_NAME}" URL → ${host.url}.`);
    }
    return true;
  } catch (error) {
    console.warn('[CronMCP] Could not register the Cron MCP server (UI plane still works):', error);
    return false;
  }
};
