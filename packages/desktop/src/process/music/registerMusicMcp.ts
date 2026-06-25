/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Start the in-process Music MCP host and ensure the MCP catalog has an `sse`
 * entry pointing at its loopback URL — so an agent can make music as tools.
 *
 * Mirrors `process/automation/registerAutomationMcp.ts`. Catalog entry is
 * created `enabled: false` (opt-in). Gated by MUSIC_STUDIO_ENABLED at the call
 * site (bootstrap) so it only registers when the feature is on. Failures are
 * swallowed/logged — registration must never block boot.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { mcpService } from '@/common/adapter/ipcBridge';
import { BUILTIN_MUSIC_NAME } from './musicMcpServer';
import { startMusic } from './musicMcpWiring';

const MUSIC_MCP_DESCRIPTION =
  'Make music: set tempo, add tracks, program step-sequencer beats, add MIDI notes, add effects, ' +
  'listen to reference audio (detect key/tempo/pitch), and comp chord progressions in the heard key. ' +
  'Shares the active project with the Music Studio page.';

export const ensureMusicMcpRegistered = async (): Promise<boolean> => {
  try {
    const host = await startMusic();

    const transport = { type: 'sse' as const, url: host.url };
    const original_json = JSON.stringify({ mcpServers: { [BUILTIN_MUSIC_NAME]: { url: host.url } } }, null, 2);

    const existing = (await mcpService.listServers.invoke()) ?? [];
    const current = existing.find((server) => server.name === BUILTIN_MUSIC_NAME);

    if (!current) {
      await mcpService.batchImportServers.invoke({
        servers: [
          {
            name: BUILTIN_MUSIC_NAME,
            description: MUSIC_MCP_DESCRIPTION,
            enabled: false,
            builtin: true,
            transport,
            original_json,
          },
        ],
      });
      console.log(`[MusicMCP] Registered "${BUILTIN_MUSIC_NAME}" at ${host.url}.`);
      return true;
    }

    const sameUrl = current.transport.type === 'sse' && current.transport.url === host.url;
    if (!sameUrl) {
      await mcpService.updateServer.invoke({ id: current.id, data: { transport, original_json, builtin: true } });
      console.log(`[MusicMCP] Updated "${BUILTIN_MUSIC_NAME}" URL → ${host.url}.`);
    }
    return true;
  } catch (error) {
    console.warn('[MusicMCP] Could not register the Music MCP server (UI plane still works):', error);
    return false;
  }
};
