/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wires the agent-facing Music MCP server. Assembles {@link MusicServerDeps}
 * from the shared music services (the SAME repo + active-project the IPC bridge
 * / UI plane use) and starts the in-process SSE host.
 *
 * One service, two planes: a track the agent adds shows up in the Music Studio
 * page and vice-versa — single source of truth on disk.
 *
 * Process boundary: Main-process (Node.js / Electron) module.
 */

import { createMusicServer, type MusicServerDeps } from './musicMcpServer';
import { startMusicMcpHost, type MusicMcpHost } from './musicMcpHost';
import { getMusicServices } from './musicServices';

let cachedDeps: MusicServerDeps | undefined;

export const getMusicServerDeps = (): MusicServerDeps => {
  if (cachedDeps) return cachedDeps;
  const services = getMusicServices();
  cachedDeps = {
    loadProject: () => services.loadActiveProject(),
    saveProject: (project) => services.saveActiveProject(project),
    loadAudio: () => services.loadActiveAudio(),
  };
  return cachedDeps;
};

export const buildMusicServer = () => createMusicServer(getMusicServerDeps());

export const startMusic = (): Promise<MusicMcpHost> => startMusicMcpHost(getMusicServerDeps());
