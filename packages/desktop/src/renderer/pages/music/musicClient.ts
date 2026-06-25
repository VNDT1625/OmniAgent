/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-side client for the Music IPC bridge.
 *
 * Mirrors the other renderer bridge clients: re-declares the channel-name
 * strings (kept in sync with `MUSIC_CHANNELS`), rebuilds matching
 * `bridge.buildProvider` invokers, and borrows only **types** via `import type`
 * (the Main bridge module uses Node fs and must not load in the renderer).
 * Calls are timeout-guarded so an unwired bridge rejects fast instead of hanging.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type { Project, ProjectSummary, Sample } from '@aionui/music-core';
import type { LoadSampleResult, MusicResult, RenderResult } from '@process/music/musicBridge';

const MUSIC_CHANNELS = {
  list: 'music.list',
  create: 'music.create',
  open: 'music.open',
  save: 'music.save',
  remove: 'music.remove',
  importSample: 'music.importSample',
  loadSample: 'music.loadSample',
  render: 'music.render',
} as const;

const channels = {
  list: bridge.buildProvider<MusicResult<ProjectSummary[]>, void>(MUSIC_CHANNELS.list),
  create: bridge.buildProvider<MusicResult<{ project: Project; path: string }>, { name: string }>(
    MUSIC_CHANNELS.create
  ),
  open: bridge.buildProvider<MusicResult<Project>, { path: string }>(MUSIC_CHANNELS.open),
  save: bridge.buildProvider<MusicResult<boolean>, { path: string; project: Project }>(MUSIC_CHANNELS.save),
  remove: bridge.buildProvider<MusicResult<boolean>, { path: string }>(MUSIC_CHANNELS.remove),
  importSample: bridge.buildProvider<MusicResult<Sample>, { path: string; sourcePath: string }>(
    MUSIC_CHANNELS.importSample
  ),
  loadSample: bridge.buildProvider<MusicResult<LoadSampleResult>, { path: string; sampleId: string }>(
    MUSIC_CHANNELS.loadSample
  ),
  render: bridge.buildProvider<MusicResult<RenderResult>, { path: string; project: Project; stems?: boolean }>(
    MUSIC_CHANNELS.render
  ),
};

const DEFAULT_TIMEOUT = 15_000;
const RENDER_TIMEOUT = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Music bridge "${label}" timed out`)), ms)),
  ]);
}

export const musicClient = {
  list: () => withTimeout(channels.list.invoke(), DEFAULT_TIMEOUT, 'list'),
  create: (name: string) => withTimeout(channels.create.invoke({ name }), DEFAULT_TIMEOUT, 'create'),
  open: (path: string) => withTimeout(channels.open.invoke({ path }), DEFAULT_TIMEOUT, 'open'),
  save: (path: string, project: Project) =>
    withTimeout(channels.save.invoke({ path, project }), DEFAULT_TIMEOUT, 'save'),
  remove: (path: string) => withTimeout(channels.remove.invoke({ path }), DEFAULT_TIMEOUT, 'remove'),
  importSample: (path: string, sourcePath: string) =>
    withTimeout(channels.importSample.invoke({ path, sourcePath }), DEFAULT_TIMEOUT, 'importSample'),
  loadSample: (path: string, sampleId: string) =>
    withTimeout(channels.loadSample.invoke({ path, sampleId }), DEFAULT_TIMEOUT, 'loadSample'),
  render: (path: string, project: Project, stems?: boolean) =>
    withTimeout(channels.render.invoke({ path, project, stems }), RENDER_TIMEOUT, 'render'),
};
