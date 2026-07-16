/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared Music services (Main process) — a single source of truth for the
 * project repo + the "active project" pointer, shared by the IPC bridge (user
 * plane) and the MCP server (agent plane). Both edit the SAME project on disk,
 * which is what makes user + agent collaborate on one song.
 *
 * Process boundary: Main-process (Node.js / Electron) module. No DOM APIs.
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { decodeWav, type Project, type ToolAudio } from '@aionui/music-core';
import { FileProjectRepo } from './fileProjectRepo';

export type MusicServices = {
  repo: FileProjectRepo;
  /** Folder path of the currently-open project, if any. */
  getActivePath: () => string | undefined;
  setActivePath: (folder: string | undefined) => void;
  /** Load the active project (create a default one if none is open). */
  loadActiveProject: () => Promise<Project>;
  /** Persist a project to the active folder. */
  saveActiveProject: (project: Project) => Promise<void>;
  /** Load reference audio (first sample of the active project) for analysis. */
  loadActiveAudio: () => Promise<ToolAudio | undefined>;
};

let cached: MusicServices | undefined;

/** Resolve the music projects directory under the app user-data dir. */
function resolveProjectsDir(): string {
  // electron app may not be available in unit context; fall back to cwd.
  let base: string;
  try {
    // Lazy require so this module stays importable in tests.
    const electron = require('electron') as { app?: { getPath?: (k: string) => string } };
    base = electron.app?.getPath?.('userData') ?? process.cwd();
  } catch {
    base = process.cwd();
  }
  return path.join(base, 'music-projects');
}

export function getMusicServices(): MusicServices {
  if (cached) return cached;

  const repo = new FileProjectRepo(resolveProjectsDir());
  let activePath: string | undefined;

  cached = {
    repo,
    getActivePath: () => activePath,
    setActivePath: (folder) => {
      activePath = folder;
    },
    loadActiveProject: async () => {
      if (!activePath) {
        const created = await repo.create('Untitled');
        activePath = created.path;
        return created.project;
      }
      return repo.open(activePath);
    },
    saveActiveProject: async (project) => {
      if (!activePath) {
        const created = await repo.create(project.name || 'Untitled');
        activePath = created.path;
      }
      await repo.save(activePath, project);
    },
    loadActiveAudio: async () => {
      if (!activePath) return undefined;
      try {
        const project = await repo.open(activePath);
        const first = project.samples[0];
        if (!first) return undefined;
        const bytes = await fs.readFile(path.join(activePath, first.file));
        const decoded = decodeWav(new Uint8Array(bytes));
        return { samples: decoded.samples, sampleRate: decoded.sampleRate };
      } catch {
        return undefined;
      }
    },
  };
  return cached;
}
