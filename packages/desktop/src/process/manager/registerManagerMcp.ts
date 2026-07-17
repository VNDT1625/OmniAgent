/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Register the built-in Personal Manager MCP server (Agent plane,
 * Requirement 9.3) into the MCP catalog so a chat agent can list/create tasks,
 * notes and calendar events through tools.
 *
 * Unlike the Testing / Browser-Control / Cron servers — which drive **live**
 * Main-process singletons and are therefore hosted in-process over loopback SSE
 * — the Manager MCP server is **stdio** and data-only: it reads/writes the same
 * on-disk `manager-data.json` the UI plane uses, so there is no live state to
 * share. It is spawned as a standalone `node` process from the bundled
 * `out/main/builtin-mcp-manager.js`, mirroring the image-gen / resource servers.
 * The data directory (the Electron `userData` dir, where `managerStore` writes)
 * is injected via {@link MANAGER_DATA_DIR_ENV_KEY} because the child process
 * cannot reach `app.getPath('userData')`.
 *
 * This step is the missing wiring that previously left the Manager feature
 * UI-only: the page worked, but no agent could ever discover the
 * `manager_*` tools. Without this registration the catalog has no
 * `aionui-manager` entry, so the "Super" / MCP picker never offers it.
 *
 * The catalog entry is created `enabled: false` (available, not auto-attached to
 * every new chat): a conversation opts in via the MCP picker / the "Super"
 * capability surface. Registration is idempotent: it finds the existing entry by
 * name and refreshes the transport when the bundled script path or the data dir
 * changes (e.g. after an app update), or creates it the first time.
 *
 * Called once after the backend is ready (from `runBackendMigrations`). Failures
 * are swallowed/logged — a registration problem must never block boot, and the
 * UI plane (the Manager page) keeps working regardless.
 *
 * Process boundary: Main-process (Node.js / Electron) module — no DOM APIs.
 */

import { app } from 'electron';
import { getMcpRegistry } from '@process/resources/mcpRegistry';
import type { IMcpServerTransportStdio } from '@/common/config/storage';
import { BUILTIN_MANAGER_NAME, MANAGER_DATA_DIR_ENV_KEY } from '../resources/builtinMcp/constants';
import { getBuiltinMcpScriptPath } from '../utils/initStorage';

/** Human-readable description shown for the Manager MCP server in the catalog. */
const MANAGER_MCP_DESCRIPTION =
  "Manage the user's Personal Manager: list/create/update tasks (todos), add notes, and list/create " +
  'calendar events (with fixed/flexible lock kind). Shares the same data as the Manager app — a task an ' +
  'agent creates shows up in the UI and vice-versa.';

/** Build the stdio transport for the bundled standalone Manager MCP script. */
const buildTransport = (): IMcpServerTransportStdio => {
  const scriptPath = getBuiltinMcpScriptPath('builtin-mcp-manager');
  return {
    type: 'stdio',
    command: 'node',
    args: [scriptPath],
    // The child `node` process cannot reach Electron's `app.getPath`, so the
    // data directory (where `managerStore` writes `manager-data.json`) is
    // injected here — the same dir the UI plane uses, so both planes share state.
    env: { [MANAGER_DATA_DIR_ENV_KEY]: app.getPath('userData') },
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
 * Ensure the catalog has the `aionui-manager` stdio entry, creating or
 * refreshing it as needed.
 *
 * @returns `true` when the catalog reflects the bundled server, `false` on any
 *   handled failure (logged, non-fatal — the UI plane still works).
 */
export const ensureManagerMcpRegistered = async (): Promise<boolean> => {
  try {
    const transport = buildTransport();
    const original_json = JSON.stringify(
      {
        mcpServers: {
          [BUILTIN_MANAGER_NAME]: { command: transport.command, args: transport.args, env: transport.env },
        },
      },
      null,
      2
    );

    const existing = (await getMcpRegistry().list()) ?? [];
    const current = existing.find((server) => server.name === BUILTIN_MANAGER_NAME);

    if (!current) {
      await getMcpRegistry().importMany([
        {
          name: BUILTIN_MANAGER_NAME,
          description: MANAGER_MCP_DESCRIPTION,
          // Available but not auto-attached: opt a chat in via the MCP picker
          // / "Super" surface. Default-off avoids surprising every new chat.
          enabled: false,
          builtin: true,
          transport,
          original_json,
        },
      ]);
      console.log(`[ManagerMCP] Registered "${BUILTIN_MANAGER_NAME}".`);
      return true;
    }

    // Refresh the transport if the bundled script path or data dir changed
    // (e.g. after an app update relocated the unpacked bundle).
    const stale = current.transport.type !== 'stdio' || !isSameStdioTransport(current.transport, transport);
    if (stale) {
      await getMcpRegistry().update(current.id, { transport, original_json, builtin: true });
      console.log(`[ManagerMCP] Refreshed "${BUILTIN_MANAGER_NAME}" transport.`);
    }
    return true;
  } catch (error) {
    console.warn('[ManagerMCP] Could not register the Manager MCP server (UI plane still works):', error);
    return false;
  }
};
