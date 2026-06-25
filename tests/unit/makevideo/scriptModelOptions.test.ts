/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the Make Video script-model option builder. Verifies the
 * "local LLM · CLI · API key" triad is surfaced in a single picker: provider
 * models (cloud API key OR local OpenAI-compatible server) plus CLI agents,
 * de-duplicated, with unavailable agents skipped.
 *
 * Pure helper — no React, no hooks, no network.
 */

import { describe, expect, it } from 'vitest';
import type { IProvider } from '@/common/config/storage';
import type { AgentMetadata } from '@/renderer/utils/model/agentTypes';
import { buildScriptModelOptions } from '@/renderer/pages/studio/makevideo/scriptModelOptions';

/** Build a minimal provider with the given enabled models. */
const provider = (id: string, models: string[]): IProvider => ({ id, name: id, models } as unknown as IProvider);

/** The capability-filtered accessor that `useModelProviderList` exposes. */
const getModels = (p: IProvider): string[] => p.models ?? [];

/** Build a minimal CLI agent metadata record. */
const agent = (over: Partial<AgentMetadata>): AgentMetadata => ({ id: 'a', name: 'Agent', ...over } as AgentMetadata);

describe('buildScriptModelOptions', () => {
  it('lists provider models first, tagged as provider kind', () => {
    const options = buildScriptModelOptions(
      [provider('openai', ['gpt-4o']), provider('local', ['llama3.1'])],
      getModels,
      []
    );
    expect(options).toEqual([
      { value: 'gpt-4o', label: 'gpt-4o', kind: 'provider' },
      { value: 'llama3.1', label: 'llama3.1', kind: 'provider' },
    ]);
  });

  it('appends CLI agents with no ACP models as a single cli:<id> option', () => {
    const options = buildScriptModelOptions([], getModels, [agent({ id: 'claude-code', name: 'Claude Code' })]);
    expect(options).toEqual([{ value: 'cli:claude-code', label: 'Claude Code', kind: 'cli' }]);
  });

  it('expands a CLI agent that advertises ACP models into one option per model', () => {
    const withModels = agent({
      id: 'gemini',
      name: 'Gemini CLI',
      handshake: { available_models: { available_models: [{ id: 'flash', label: 'Flash' }, { id: 'pro' }] } },
    } as unknown as Partial<AgentMetadata>);
    const options = buildScriptModelOptions([], getModels, [withModels]);
    expect(options).toEqual([
      { value: 'cli:gemini?model=flash', label: 'Gemini CLI / Flash', kind: 'cli' },
      { value: 'cli:gemini?model=pro', label: 'Gemini CLI / pro', kind: 'cli' },
    ]);
  });

  it('skips agents that are unavailable or disabled', () => {
    const options = buildScriptModelOptions([], getModels, [
      agent({ id: 'on', name: 'On' }),
      agent({ id: 'off1', name: 'Off1', available: false }),
      agent({ id: 'off2', name: 'Off2', enabled: false }),
    ]);
    expect(options.map((o) => o.value)).toEqual(['cli:on']);
  });

  it('de-duplicates repeated model ids across providers', () => {
    const options = buildScriptModelOptions(
      [provider('p1', ['shared', 'a']), provider('p2', ['shared', 'b'])],
      getModels,
      []
    );
    expect(options.map((o) => o.value)).toEqual(['shared', 'a', 'b']);
  });

  it('merges providers and CLI agents into one combined list', () => {
    const options = buildScriptModelOptions([provider('openai', ['gpt-4o'])], getModels, [
      agent({ id: 'codex', name: 'Codex' }),
    ]);
    expect(options.map((o) => o.kind)).toEqual(['provider', 'cli']);
  });
});
