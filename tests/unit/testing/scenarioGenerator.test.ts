/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests the scenario generator (Yêu cầu 2b — UX): a plain-language description
 * is turned into editable steps using the user's configured model. Covers the
 * happy path, defensive JSON extraction (fenced ```json), the "no model
 * configured" error, and an empty/garbage model reply.
 *
 * The provider list (`/api/providers`) and the `/chat/completions` call are
 * mocked, so no network/model is touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const httpRequest = vi.fn();
// Partial mock: keep every real export (httpPost/httpGet/… are used at module
// load by the transitively-imported ipcBridge) and only stub httpRequest.
vi.mock('@/common/adapter/httpBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/common/adapter/httpBridge')>();
  return {
    ...actual,
    httpRequest: (...args: unknown[]) => httpRequest(...args),
  };
});

import { createScenarioGenerator } from '@/process/testing/scenarioGenerator';

const usableProvider = {
  id: 'p1',
  enabled: true,
  api_key: 'sk-test',
  base_url: 'https://api.example.com/v1',
  models: ['gpt-test'],
};

/** Stub global fetch to return the given assistant message content. */
const stubModelReply = (content: string): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => '',
    }))
  );
};

beforeEach(() => {
  httpRequest.mockReset();
  httpRequest.mockResolvedValue([usableProvider]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('scenarioGenerator', () => {
  it('turns a description into ordered, sequentially-ided steps', async () => {
    stubModelReply(
      JSON.stringify({
        name: 'Open example',
        steps: ['goto example.com', 'assertText Example Domain', 'assertTitle Example'],
      })
    );
    const gen = createScenarioGenerator();
    const draft = await gen.generate({ description: 'open example.com and check it', platform: 'web' });

    expect(draft.name).toBe('Open example');
    expect(draft.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(draft.steps.map((s) => s.description)).toEqual([
      'goto example.com',
      'assertText Example Domain',
      'assertTitle Example',
    ]);
  });

  it('parses JSON wrapped in a ```json fence with surrounding prose', async () => {
    stubModelReply('Here is your test:\n```json\n{"name":"T","steps":["goto a.com","assertTitle A"]}\n```\nEnjoy!');
    const gen = createScenarioGenerator();
    const draft = await gen.generate({ description: 'x', platform: 'web' });
    expect(draft.steps.map((s) => s.description)).toEqual(['goto a.com', 'assertTitle A']);
  });

  it('falls back to a default name when the model omits one', async () => {
    stubModelReply(JSON.stringify({ steps: ['goto a.com'] }));
    const gen = createScenarioGenerator();
    const draft = await gen.generate({ description: 'x', platform: 'web' });
    expect(draft.name.length).toBeGreaterThan(0);
    expect(draft.steps).toHaveLength(1);
  });

  it('throws a clear error when no usable model is configured', async () => {
    httpRequest.mockResolvedValue([]); // no providers
    const gen = createScenarioGenerator();
    await expect(gen.generate({ description: 'x', platform: 'web' })).rejects.toThrow(/no usable model/i);
  });

  it('throws when the model reply has no usable steps', async () => {
    stubModelReply('not json at all');
    const gen = createScenarioGenerator();
    await expect(gen.generate({ description: 'x', platform: 'web' })).rejects.toThrow(
      /valid scenario JSON|usable steps/i
    );
  });

  it('rejects an empty description without calling the model', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const gen = createScenarioGenerator();
    await expect(gen.generate({ description: '   ', platform: 'web' })).rejects.toThrow(/describe/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('guides the user to a URL instead of fabricating one (needsUrl)', async () => {
    // Web + no appUrl + a vague description → model returns {"needsUrl": true}.
    stubModelReply('{"needsUrl": true}');
    const gen = createScenarioGenerator();
    await expect(gen.generate({ description: 'test the home page', platform: 'web' })).rejects.toThrow(
      /Detect from source|dev URL|localhost/i
    );
  });

  it('uses the provided appUrl in the first step', async () => {
    stubModelReply('{"name":"Home loads","steps":["goto http://localhost:5173","assertText Welcome"]}');
    const gen = createScenarioGenerator();
    const draft = await gen.generate({ description: 'check home', platform: 'web', appUrl: 'http://localhost:5173' });
    expect(draft.steps[0].description).toBe('goto http://localhost:5173');
  });

  it('fails fast with a clear message when the model routes to a CLI', async () => {
    stubModelReply('Please use Claude Code CLI');
    const gen = createScenarioGenerator();
    await expect(gen.generate({ description: 'x', platform: 'web', appUrl: 'http://localhost:5173' })).rejects.toThrow(
      /can't be called directly|different model/i
    );
  });
});
