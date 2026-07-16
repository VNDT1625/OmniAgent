/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for the browser AgentModePicker model dropdown (criterion 1.2).
 *
 * Focus: the picker must never show an empty/unclickable group header. When
 * only one source has entries (only CLI agents, or only API models) the options
 * render flat with no lone header; when both have entries both headers show.
 * This covers the "two empty group headers, can't pick a model" regression.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from '@arco-design/web-react';
import type { IProvider } from '@/common/config/storage';
import type { AgentMetadata } from '@/renderer/utils/model/agentTypes';

// i18n identity translator so assertions use raw keys.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

// Hoisted state the hook mocks read, so each test can set providers/agents.
const data = vi.hoisted(() => ({
  providers: [] as IProvider[],
  models: {} as Record<string, string[]>,
  agents: [] as AgentMetadata[],
}));

vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useModelProviderList: () => ({
    providers: data.providers,
    getAvailableModels: (p: IProvider) => data.models[p.id] ?? [],
    formatModelLabel: (_p: unknown, m?: string) => m ?? '',
  }),
}));

vi.mock('@/renderer/hooks/agent/useAgents', () => ({
  useAgents: () => ({
    agents: data.agents,
    isLoading: false,
    error: null,
    revalidate: vi.fn(),
    refreshCustomAgents: vi.fn(),
  }),
}));

import AgentModePicker from '@/renderer/pages/browser/components/AgentModePicker';

const provider = (id: string): IProvider =>
  ({ id, name: id, platform: 'openai', base_url: '', api_key: '', models: [] }) as unknown as IProvider;
const agent = (id: string, name: string): AgentMetadata =>
  ({ id, name, enabled: true, available: true }) as unknown as AgentMetadata;

const renderPicker = () =>
  render(
    <ConfigProvider>
      <AgentModePicker
        hasActiveTab
        agentModel={null}
        agentMode={false}
        onModelChange={vi.fn()}
        onToggle={vi.fn().mockResolvedValue(undefined)}
      />
    </ConfigProvider>
  );

beforeEach(() => {
  data.providers = [];
  data.models = {};
  data.agents = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const openDropdown = async () => {
  const user = userEvent.setup();
  // Click the Select control (Arco renders the placeholder inside it). Use the
  // combobox role to avoid the placeholder text appearing twice.
  await user.click(screen.getByRole('combobox'));
};

describe('AgentModePicker dropdown groups', () => {
  it('shows API models flat (no group header) when there are no CLI agents', async () => {
    data.providers = [provider('p1')];
    data.models = { p1: ['gpt-4o'] };
    renderPicker();
    await openDropdown();
    await waitFor(() => expect(screen.getByText('gpt-4o')).toBeTruthy());
    // No lone group headers when only one source has entries.
    expect(screen.queryByText('browser.agent.providerGroup')).toBeNull();
    expect(screen.queryByText('browser.agent.cliGroup')).toBeNull();
  });

  it('shows CLI agents flat (no group header) when there are no API models', async () => {
    data.agents = [agent('claude', 'Claude Code')];
    renderPicker();
    await openDropdown();
    await waitFor(() => expect(screen.getByText((content) => content.includes('Claude Code'))).toBeTruthy());
    expect(screen.queryByText('browser.agent.cliGroup')).toBeNull();
    expect(screen.queryByText('browser.agent.providerGroup')).toBeNull();
  });

  it('shows BOTH headers only when both sources have entries', async () => {
    data.providers = [provider('p1')];
    data.models = { p1: ['gpt-4o'] };
    data.agents = [agent('claude', 'Claude Code')];
    renderPicker();
    await openDropdown();
    await waitFor(() => expect(screen.getByText('browser.agent.cliGroup')).toBeTruthy());
    expect(screen.getByText('browser.agent.providerGroup')).toBeTruthy();
    // The CLI option label is "Claude Code · CLI"; match on a substring matcher
    // since Arco may split the text across nodes.
    expect(screen.getByText((content) => content.includes('Claude Code'))).toBeTruthy();
    expect(screen.getByText('gpt-4o')).toBeTruthy();
  });

  it('shows the empty-state note when neither source has entries', async () => {
    renderPicker();
    await openDropdown();
    await waitFor(() => expect(screen.getByText('browser.agent.noModels')).toBeTruthy());
  });
});
