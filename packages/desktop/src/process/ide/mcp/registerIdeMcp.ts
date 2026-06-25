/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Registers the IDE MCP server (Agent plane) into the MCP catalog so aioncore's
 * agent — and any company role granted "IDE powers" (Requirement 9) — can reach
 * it.
 *
 * Because the IDE capability walks the filesystem and reuses live Main-process
 * helpers, it is hosted **in-process** over a loopback SSE endpoint
 * (`ideMcpHost.ts`) rather than spawned as a stdio child. The loopback port is
 * ephemeral (changes each boot), so this registration is idempotent: it finds
 * the existing catalog entry by name and updates its URL, or creates it the
 * first time. The entry is created `enabled: false` (opt-in per conversation /
 * per role) — it is not auto-attached to every chat.
 *
 * Called once after the backend is ready (from `runBackendMigrations`). Failures
 * are swallowed/logged — a registration problem must never block boot, and the
 * IDE UI plane keeps working regardless. Mirrors `registerCronMcp.ts`.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { mcpService } from '@/common/adapter/ipcBridge';
import { startIdeMcpHost } from './ideMcpHost';
import { BUILTIN_IDE_NAME } from './ideServer';

/** Human-readable description shown for the IDE MCP server in the catalog. */
const IDE_MCP_DESCRIPTION =
  'Built-in IDE / repo-intelligence tools. Lets an agent explore a project folder: list directories, ' +
  'read files anywhere on disk, grep across the repo, jump to a symbol definition / references, and ' +
  'scan a repo into an import-graph summary. Shares behaviour with the IDE workspace.';

/**
 * Start the in-process IDE MCP host and ensure the MCP catalog has an `sse`
 * server entry pointing at its loopback URL.
 *
 * @returns `true` when the catalog reflects the running host, `false` on any
 *   handled failure (logged, non-fatal — the IDE UI plane still works).
 */
export const ensureIdeMcpRegistered = async (): Promise<boolean> => {
  try {
    const host = await startIdeMcpHost();

    const transport = { type: 'sse' as const, url: host.url };
    const original_json = JSON.stringify({ mcpServers: { [BUILTIN_IDE_NAME]: { url: host.url } } }, null, 2);

    const existing = (await mcpService.listServers.invoke()) ?? [];
    const current = existing.find((server) => server.name === BUILTIN_IDE_NAME);

    if (!current) {
      await mcpService.batchImportServers.invoke({
        servers: [
          {
            name: BUILTIN_IDE_NAME,
            description: IDE_MCP_DESCRIPTION,
            enabled: false,
            builtin: true,
            transport,
            original_json,
          },
        ],
      });
      console.log(`[IdeMCP] Registered "${BUILTIN_IDE_NAME}" at ${host.url}.`);
      return true;
    }

    // Refresh the URL if the ephemeral port changed since the last boot.
    const sameUrl = current.transport.type === 'sse' && current.transport.url === host.url;
    if (!sameUrl) {
      await mcpService.updateServer.invoke({
        id: current.id,
        data: { transport, original_json, builtin: true },
      });
      console.log(`[IdeMCP] Updated "${BUILTIN_IDE_NAME}" URL → ${host.url}.`);
    }
    return true;
  } catch (error) {
    console.warn('[IdeMCP] Could not register the IDE MCP server (UI plane still works):', error);
    return false;
  }
};
