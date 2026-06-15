/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the Music MCP server (agent plane) — drives the tools through an
 * in-memory MCP client over the SDK's linked in-process transport, against fake
 * deps. Verifies the agent can build music and "listen" via MCP, all routed
 * through @aionui/music-core's dispatchTool.
 */

import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMusicServer, type MusicServerDeps } from '@/process/music/musicMcpServer';
import { chordFromMidi, createProject, type Project } from '@aionui/music-core';

const SR = 44100;

/** A mutable in-memory project store for the fake deps. */
const makeDeps = (overrides: Partial<MusicServerDeps> = {}): { deps: MusicServerDeps; current: () => Project } => {
  let project = createProject('Test Song');
  const deps: MusicServerDeps = {
    loadProject: vi.fn(async () => project),
    saveProject: vi.fn(async (p: Project) => {
      project = p;
    }),
    loadAudio: vi.fn(async () => ({ samples: chordFromMidi([60, 64, 67], 1, SR), sampleRate: SR })),
    ...overrides,
  };
  return { deps, current: () => project };
};

const connect = async (deps: MusicServerDeps) => {
  const server = createMusicServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
};

const textOf = (result: unknown): string => {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
};

describe('musicMcpServer', () => {
  it('exposes music_ tools including get_project, set_tempo, listen', async () => {
    const { deps } = makeDeps();
    const client = await connect(deps);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('music_get_project');
    expect(names).toContain('music_set_tempo');
    expect(names).toContain('music_add_track');
    expect(names).toContain('music_listen');
  });

  it('set_tempo persists the project', async () => {
    const { deps, current } = makeDeps();
    const client = await connect(deps);
    const result = await client.callTool({
      name: 'music_set_tempo',
      arguments: { args: JSON.stringify({ bpm: 128 }) },
    });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(current().tempo).toBe(128);
    expect(deps.saveProject).toHaveBeenCalled();
  });

  it('add_track returns a trackId in data', async () => {
    const { deps } = makeDeps();
    const client = await connect(deps);
    const result = await client.callTool({
      name: 'music_add_track',
      arguments: { args: JSON.stringify({ name: 'Drums' }) },
    });
    const payload = JSON.parse(textOf(result)) as { data: { trackId: string } };
    expect(payload.data.trackId).toBeTruthy();
  });

  it('listen analyzes reference audio and returns a key', async () => {
    const { deps } = makeDeps();
    const client = await connect(deps);
    const result = await client.callTool({ name: 'music_listen', arguments: { args: '{}' } });
    const payload = JSON.parse(textOf(result)) as { data: { key: string } };
    expect(typeof payload.data.key).toBe('string');
  });

  it('reports bad args as an error without throwing', async () => {
    const { deps } = makeDeps();
    const client = await connect(deps);
    const result = await client.callTool({ name: 'music_set_tempo', arguments: { args: 'not-json' } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/invalid args/i);
  });

  it('set_tempo with invalid bpm returns ok:false (no throw)', async () => {
    const { deps } = makeDeps();
    const client = await connect(deps);
    const result = await client.callTool({ name: 'music_set_tempo', arguments: { args: JSON.stringify({ bpm: 0 }) } });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('get_project returns tempo and tracks', async () => {
    const { deps } = makeDeps();
    const client = await connect(deps);
    const result = await client.callTool({ name: 'music_get_project', arguments: {} });
    const payload = JSON.parse(textOf(result)) as { tempo: number; tracks: unknown[] };
    expect(typeof payload.tempo).toBe('number');
    expect(Array.isArray(payload.tracks)).toBe(true);
  });
});
