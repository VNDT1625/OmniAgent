/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Music IPC bridge — lets the renderer (Music Studio page) list/create/open/
 * save music projects and render audio via the Main-process repo + the headless
 * @aionui/music-core engine. All channels return an always-resolving envelope so
 * the renderer never hangs.
 *
 * The renderer realtime engine (Tone.js) plays audio itself; this bridge is for
 * persistence and offline render/export (which need Node fs + the render core).
 *
 * Process boundary: Main-process (Node.js / Electron) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  createSample,
  decodeWav,
  encodeWav,
  renderProject,
  renderStems,
  synthDrumBank,
  type SampleBank,
  type Project,
  type ProjectSummary,
  type Sample,
} from '@aionui/music-core';
import { getMusicServices } from './musicServices';

export const MUSIC_CHANNELS = {
  list: 'music.list',
  create: 'music.create',
  open: 'music.open',
  save: 'music.save',
  remove: 'music.remove',
  importSample: 'music.importSample',
  loadSample: 'music.loadSample',
  render: 'music.render',
} as const;

export type MusicResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type CreateRequest = { name: string };
export type OpenRequest = { path: string };
export type SaveRequest = { path: string; project: Project };
export type RemoveRequest = { path: string };
export type ImportSampleRequest = { path: string; sourcePath: string };
export type LoadSampleRequest = { path: string; sampleId: string };
export type LoadSampleResult = { sampleId: string; bytes: Uint8Array };
export type RenderRequest = { path: string; project: Project; stems?: boolean };
export type RenderResult = { mixPath: string; stemPaths: string[] };

export const musicChannels = {
  list: bridge.buildProvider<MusicResult<ProjectSummary[]>, void>(MUSIC_CHANNELS.list),
  create: bridge.buildProvider<MusicResult<{ project: Project; path: string }>, CreateRequest>(MUSIC_CHANNELS.create),
  open: bridge.buildProvider<MusicResult<Project>, OpenRequest>(MUSIC_CHANNELS.open),
  save: bridge.buildProvider<MusicResult<boolean>, SaveRequest>(MUSIC_CHANNELS.save),
  remove: bridge.buildProvider<MusicResult<boolean>, RemoveRequest>(MUSIC_CHANNELS.remove),
  importSample: bridge.buildProvider<MusicResult<Sample>, ImportSampleRequest>(MUSIC_CHANNELS.importSample),
  loadSample: bridge.buildProvider<MusicResult<LoadSampleResult>, LoadSampleRequest>(MUSIC_CHANNELS.loadSample),
  render: bridge.buildProvider<MusicResult<RenderResult>, RenderRequest>(MUSIC_CHANNELS.render),
};

const RENDERS_DIR = 'renders';
const SR = 44100;

function resolveProjectRelativeFile(projectPath: string, relativeFile: string): string {
  const resolved = path.resolve(projectPath, relativeFile);
  const root = path.resolve(projectPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Sample path escapes project folder: ${relativeFile}`);
  }
  return resolved;
}

async function loadProjectSampleBank(projectPath: string, project: Project): Promise<SampleBank> {
  const bank = synthDrumBank(SR);
  await Promise.all(
    project.samples.map(async (sample) => {
      try {
        const bytes = await fs.readFile(resolveProjectRelativeFile(projectPath, sample.file));
        bank.set(sample.id, decodeWav(new Uint8Array(bytes)));
      } catch (error) {
        if (sample.id === 'kick') return;
        throw error;
      }
    })
  );
  return bank;
}

/** Register the music IPC handlers. Idempotent; call once during bootstrap. */
export function registerMusicBridge(): void {
  const services = getMusicServices();

  musicChannels.list.provider(async (): Promise<MusicResult<ProjectSummary[]>> => {
    try {
      return { ok: true, data: await services.repo.list() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  musicChannels.create.provider(async (req): Promise<MusicResult<{ project: Project; path: string }>> => {
    try {
      const created = await services.repo.create(req.name);
      services.setActivePath(created.path);
      return { ok: true, data: created };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  musicChannels.open.provider(async (req): Promise<MusicResult<Project>> => {
    try {
      const project = await services.repo.open(req.path);
      services.setActivePath(req.path);
      return { ok: true, data: project };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  musicChannels.save.provider(async (req): Promise<MusicResult<boolean>> => {
    try {
      await services.repo.save(req.path, req.project);
      services.setActivePath(req.path);
      return { ok: true, data: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  musicChannels.remove.provider(async (req): Promise<MusicResult<boolean>> => {
    try {
      await services.repo.remove(req.path);
      if (services.getActivePath() === req.path) services.setActivePath(undefined);
      return { ok: true, data: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  musicChannels.importSample.provider(async (req): Promise<MusicResult<Sample>> => {
    try {
      const imported = await services.repo.importSample(req.path, req.sourcePath);
      const bytes = await fs.readFile(path.join(req.path, imported.file));
      const decoded = decodeWav(new Uint8Array(bytes));
      const sampleName = path.basename(req.sourcePath, path.extname(req.sourcePath));
      const sample = createSample(
        imported.file,
        sampleName,
        decoded.samples.length / decoded.sampleRate,
        decoded.sampleRate
      );
      services.setActivePath(req.path);
      return { ok: true, data: sample };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  musicChannels.loadSample.provider(async (req): Promise<MusicResult<LoadSampleResult>> => {
    try {
      const project = await services.repo.open(req.path);
      const sample = project.samples.find((candidate) => candidate.id === req.sampleId);
      if (!sample) throw new Error(`Sample not found: ${req.sampleId}`);
      const bytes = await fs.readFile(resolveProjectRelativeFile(req.path, sample.file));
      services.setActivePath(req.path);
      return { ok: true, data: { sampleId: sample.id, bytes: new Uint8Array(bytes) } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  musicChannels.render.provider(async (req): Promise<MusicResult<RenderResult>> => {
    try {
      const bank = await loadProjectSampleBank(req.path, req.project);
      const rendersDir = path.join(req.path, RENDERS_DIR);
      await fs.mkdir(rendersDir, { recursive: true });

      const mix = renderProject(req.project, bank, { sampleRate: SR, tailSec: 1 });
      const mixPath = path.join(rendersDir, 'mix.wav');
      await fs.writeFile(mixPath, encodeWav(mix));

      const stemPaths: string[] = [];
      if (req.stems) {
        const stems = renderStems(req.project, bank, { sampleRate: SR, tailSec: 1 });
        await Promise.all(
          stems.map(async (stem) => {
            const safe = stem.trackName.replace(/[^a-z0-9_-]+/gi, '_');
            const stemPath = path.join(rendersDir, `${safe}.wav`);
            await fs.writeFile(stemPath, encodeWav(stem.buffer));
            stemPaths.push(stemPath);
          })
        );
      }
      return { ok: true, data: { mixPath, stemPaths } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
