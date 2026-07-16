/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Start the in-process Realtime Knowledge MCP host and ensure the MCP catalog
 * has an `sse` entry pointing at its loopback URL — so any agent can attach it
 * and look up / keep time-sensitive facts current.
 *
 * Mirrors `process/editor/registerOfficeEditorMcp.ts`. The catalog entry is
 * created `enabled: false` (opt-in). The loopback port is ephemeral, so this
 * registration is idempotent — it finds the existing entry by name and refreshes
 * its URL, or creates it. Failures are swallowed/logged — a registration problem
 * must never block boot.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { mcpService } from '@/common/adapter/ipcBridge';
import { BUILTIN_REALTIME_KNOWLEDGE_NAME } from '../resources/builtinMcp/realtimeKnowledgeServer';
import { startRealtimeKnowledge } from './realtimeKnowledgeMcpWiring';

/** Human-readable description shown for the Realtime Knowledge MCP server in the catalog. */
const REALTIME_KNOWLEDGE_MCP_DESCRIPTION =
  'Look up and keep time-sensitive facts current (versions, prices, current role holders, evolving ' +
  'specs, statistics). Use rtk_lookup before answering to avoid stale training data, and rtk_record ' +
  'to store facts you verified with your web/browser tools (RTK enforces a source-backed update guardrail).';

/**
 * Start the host and register/refresh its `sse` entry in the MCP catalog.
 *
 * @returns `true` when the catalog reflects the running host, `false` on any
 *   handled failure (logged, non-fatal).
 */
export const ensureRealtimeKnowledgeMcpRegistered = async (): Promise<boolean> => {
  try {
    const host = await startRealtimeKnowledge();

    const transport = { type: 'sse' as const, url: host.url };
    const original_json = JSON.stringify(
      { mcpServers: { [BUILTIN_REALTIME_KNOWLEDGE_NAME]: { url: host.url } } },
      null,
      2
    );

    const existing = (await mcpService.listServers.invoke()) ?? [];
    const current = existing.find((server) => server.name === BUILTIN_REALTIME_KNOWLEDGE_NAME);

    if (!current) {
      await mcpService.batchImportServers.invoke({
        servers: [
          {
            name: BUILTIN_REALTIME_KNOWLEDGE_NAME,
            description: REALTIME_KNOWLEDGE_MCP_DESCRIPTION,
            enabled: false,
            builtin: true,
            transport,
            original_json,
          },
        ],
      });
      console.log(`[RealtimeKnowledgeMCP] Registered "${BUILTIN_REALTIME_KNOWLEDGE_NAME}" at ${host.url}.`);
      return true;
    }

    const sameUrl = current.transport.type === 'sse' && current.transport.url === host.url;
    if (!sameUrl) {
      await mcpService.updateServer.invoke({
        id: current.id,
        data: { transport, original_json, builtin: true },
      });
      console.log(`[RealtimeKnowledgeMCP] Updated "${BUILTIN_REALTIME_KNOWLEDGE_NAME}" URL → ${host.url}.`);
    }
    return true;
  } catch (error) {
    console.warn('[RealtimeKnowledgeMCP] Could not register the Realtime Knowledge MCP server:', error);
    return false;
  }
};
