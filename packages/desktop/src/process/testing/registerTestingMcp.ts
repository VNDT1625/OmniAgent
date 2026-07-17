/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Registers the Testing MCP server (Agent plane, Yêu cầu 2b — Task 15.1) into
 * the MCP catalog so aioncore's agent can reach it.
 *
 * Because the Testing capability drives a live Main-process singleton, it is
 * hosted **in-process** over a loopback SSE endpoint (`testingMcpHost.ts`)
 * rather than spawned as a stdio child. The loopback port is ephemeral (changes
 * each boot), so this registration is idempotent: it finds the existing catalog
 * entry by name and updates its URL, or creates it the first time.
 *
 * Called once after the backend is ready (from `runBackendMigrations`). Failures
 * are swallowed/logged — a registration problem must never block boot, and the
 * UI plane (the Testing page) keeps working regardless.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { getMcpRegistry } from '@process/resources/mcpRegistry';
import { getApplicationMainWindow } from '../bridge/applicationBridge';
import { BUILTIN_TESTING_NAME } from '../resources/builtinMcp/testingServer';
import { startTestingMcpHost } from './testingMcpHost';
import { getTestingServices } from './testingWiring';

/** Human-readable description shown for the Testing MCP server in the catalog. */
const TESTING_MCP_DESCRIPTION =
  'Built-in multi-platform testing tools (web/Android/Windows). Lets an agent run a test ' +
  'scenario in an isolated display, then fetch its report. Shares state with the Testing page.';

/**
 * Start the in-process Testing MCP host and ensure the MCP catalog has an `sse`
 * server entry pointing at its loopback URL.
 *
 * @returns `true` when the catalog reflects the running host, `false` on any
 *   handled failure (logged, non-fatal).
 */
export const ensureTestingMcpRegistered = async (): Promise<boolean> => {
  try {
    const { orchestrator } = getTestingServices(getApplicationMainWindow);
    const host = await startTestingMcpHost(orchestrator);

    const transport = { type: 'sse' as const, url: host.url };
    const original_json = JSON.stringify({ mcpServers: { [BUILTIN_TESTING_NAME]: { url: host.url } } }, null, 2);

    const existing = (await getMcpRegistry().list()) ?? [];
    const current = existing.find((server) => server.name === BUILTIN_TESTING_NAME);

    if (!current) {
      await getMcpRegistry().importMany([
        {
          name: BUILTIN_TESTING_NAME,
          description: TESTING_MCP_DESCRIPTION,
          enabled: true,
          builtin: true,
          transport,
          original_json,
        },
      ]);
      console.log(`[TestingMCP] Registered "${BUILTIN_TESTING_NAME}" at ${host.url}.`);
      return true;
    }

    // Refresh the URL if the ephemeral port changed since the last boot.
    const sameUrl = current.transport.type === 'sse' && current.transport.url === host.url;
    if (!sameUrl) {
      await getMcpRegistry().update(current.id, { transport, original_json, builtin: true });
      console.log(`[TestingMCP] Updated "${BUILTIN_TESTING_NAME}" URL → ${host.url}.`);
    }
    return true;
  } catch (error) {
    console.warn('[TestingMCP] Could not register the Testing MCP server (UI plane still works):', error);
    return false;
  }
};
