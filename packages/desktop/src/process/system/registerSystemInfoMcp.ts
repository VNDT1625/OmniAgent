/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Register the built-in System Insight MCP server (Agent plane) into the MCP
 * catalog so a chat agent can read the host computer's status through a tool
 * instead of running ad-hoc shell commands.
 *
 * Like the Resource / Manager servers, this is a **stdio**, data-only server: it
 * reads the same on-disk `system-snapshot.json` the live sampler writes, so
 * there is no live state to share over loopback SSE. It is spawned as a
 * standalone `node` process from the bundled `out/main/builtin-mcp-system.js`.
 * The snapshot directory (Electron `userData`) is injected via
 * {@link SYSTEM_SNAPSHOT_DIR_ENV_KEY} because the child cannot reach
 * `app.getPath('userData')`.
 *
 * The catalog entry is created `enabled: false` (available, not auto-attached to
 * every chat): a conversation opts in via the MCP picker / "Super" surface.
 * Registration is idempotent: it finds the existing entry by name and refreshes
 * the transport when the bundled script path or the snapshot dir changes.
 *
 * Process boundary: Main-process (Node.js / Electron) module — no DOM APIs.
 */

import { app } from 'electron';
import { mcpService } from '@/common/adapter/ipcBridge';
import type { IMcpServerTransportStdio } from '@/common/config/storage';
import { BUILTIN_SYSTEM_NAME, SYSTEM_SNAPSHOT_DIR_ENV_KEY } from '../resources/builtinMcp/constants';
import { getBuiltinMcpScriptPath } from '../utils/initStorage';

/** Human-readable description shown for the System MCP server in the catalog. */
const SYSTEM_MCP_DESCRIPTION =
  "Read the host computer's status (CPU, RAM, GPU, disks, network, versions and the heaviest running " +
  'processes) from AionUi System Insight. Use it instead of running shell commands like top / ps / wmic / ' +
  'systeminfo to inspect the machine. Read-only.';

/** Build the stdio transport for the bundled standalone System MCP script. */
const buildTransport = (): IMcpServerTransportStdio => {
  const scriptPath = getBuiltinMcpScriptPath('builtin-mcp-system');
  return {
    type: 'stdio',
    command: 'node',
    args: [scriptPath],
    env: { [SYSTEM_SNAPSHOT_DIR_ENV_KEY]: app.getPath('userData') },
  };
};

/** Whether two stdio transports are equivalent (command + args + env). */
const isSameStdioTransport = (left: IMcpServerTransportStdio, right: IMcpServerTransportStdio): boolean => {
  const sameArgs =
    (left.args ?? []).length === (right.args ?? []).length &&
    (left.args ?? []).every((arg, index) => arg === (right.args ?? [])[index]);
  const leftEnv = left.env ?? {};
  const rightEnv = right.env ?? {};
  const sameEnv =
    Object.keys(leftEnv).length === Object.keys(rightEnv).length &&
    Object.keys(leftEnv).every((key) => leftEnv[key] === rightEnv[key]);
  return left.command === right.command && sameArgs && sameEnv;
};

/**
 * Ensure the catalog has the `aionui-system` stdio entry, creating or refreshing
 * it as needed.
 *
 * @returns `true` when the catalog reflects the bundled server, `false` on any
 *   handled failure (logged, non-fatal — the UI plane still works).
 */
export const ensureSystemInfoMcpRegistered = async (): Promise<boolean> => {
  try {
    const transport = buildTransport();
    const original_json = JSON.stringify(
      { mcpServers: { [BUILTIN_SYSTEM_NAME]: { command: transport.command, args: transport.args, env: transport.env } } },
      null,
      2
    );

    const existing = (await mcpService.listServers.invoke()) ?? [];
    const current = existing.find((server) => server.name === BUILTIN_SYSTEM_NAME);

    if (!current) {
      await mcpService.batchImportServers.invoke({
        servers: [
          {
            name: BUILTIN_SYSTEM_NAME,
            description: SYSTEM_MCP_DESCRIPTION,
            enabled: false,
            builtin: true,
            transport,
            original_json,
          },
        ],
      });
      console.log(`[SystemMCP] Registered "${BUILTIN_SYSTEM_NAME}".`);
      return true;
    }

    const stale = current.transport.type !== 'stdio' || !isSameStdioTransport(current.transport, transport);
    if (stale) {
      await mcpService.updateServer.invoke({ id: current.id, data: { transport, original_json, builtin: true } });
      console.log(`[SystemMCP] Refreshed "${BUILTIN_SYSTEM_NAME}" transport.`);
    }
    return true;
  } catch (error) {
    console.warn('[SystemMCP] Could not register the System MCP server (UI plane still works):', error);
    return false;
  }
};
