/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for renderer/hooks/assistant/useDetectedAgents.ts (A4 in N4a).
 * Tests useDetectedAgents hook: agent detection via SWR and refresh trigger.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock SWR
vi.mock('swr', () => ({
  default: vi.fn(() => {
    // Return mock data immediately for simplicity
    return { data: [], error: null, isLoading: false };
  }),
  mutate: vi.fn(),
}));

// Mock @/common
vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: {
      refreshCustomAgents: { invoke: vi.fn() },
    },
  },
}));

// Mock agentTypes module
vi.mock('@/renderer/utils/model/agentTypes', () => ({
  DETECTED_AGENTS_SWR_KEY: 'detected-agents',
  fetchDetectedAgents: vi.fn(),
}));

import { useDetectedAgents } from '@/renderer/hooks/assistant/useDetectedAgents';
import { ipcBridge } from '@/common';
import useSWR, { mutate } from 'swr';
import type { AgentMetadata } from '@/renderer/utils/model/agentTypes';

const useSWRMock = useSWR as unknown as Mock;
const refreshCustomAgentsMock = ipcBridge.acpConversation.refreshCustomAgents.invoke as unknown as Mock;

describe('useDetectedAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty availableBackends when no agents detected', () => {
    useSWRMock.mockReturnValue({ data: [], error: null });

    const { result } = renderHook(() => useDetectedAgents());

    expect(result.current.availableBackends).toEqual([]);
  });

  it('filters and maps detected agents to availableBackends', () => {
    // Option `id` must be the backend slug (what `preset_agent_type` stores),
    // not the AgentMetadata row id — otherwise the assistant editor saves a row
    // id (e.g. "2d23ff1c") as `preset_agent_type`, which later resolves to no
    // agent.
    const mockAgents: AgentMetadata[] = [
      { id: 'a1', name: 'ClaudeCode', agent_type: 'acp', agent_source: 'builtin', backend: 'claude' },
      { id: 'a2', name: 'ExtAgent', agent_type: 'nanobot', agent_source: 'extension' },
      { id: 'a3', name: 'RemoteAgent', agent_type: 'remote', agent_source: 'builtin' },
    ];
    useSWRMock.mockReturnValue({ data: mockAgents, error: null });

    const { result } = renderHook(() => useDetectedAgents());

    expect(result.current.availableBackends).toHaveLength(2); // 'remote' excluded
    // backend slug wins when present
    expect(result.current.availableBackends[0]).toEqual({ id: 'claude', name: 'ClaudeCode', isExtension: false });
    // falls back to agent_type when backend is absent (e.g. internal engines)
    expect(result.current.availableBackends[1]).toEqual({ id: 'nanobot', name: 'ExtAgent', isExtension: true });
  });

  it('uses custom agent row ids so multiple custom ACP agents remain selectable', () => {
    const mockAgents: AgentMetadata[] = [
      {
        id: 'deepseek-tui-row',
        name: 'DeepSeek TUI',
        agent_type: 'acp',
        agent_source: 'custom',
      },
      {
        id: 'antigravity-row',
        name: 'Antigravity',
        agent_type: 'acp',
        agent_source: 'custom',
      },
    ];
    useSWRMock.mockReturnValue({ data: mockAgents, error: null });

    const { result } = renderHook(() => useDetectedAgents());

    expect(result.current.availableBackends).toEqual([
      { id: 'deepseek-tui-row', name: 'DeepSeek TUI', isExtension: false },
      { id: 'antigravity-row', name: 'Antigravity', isExtension: false },
    ]);
  });

  it('calls refreshCustomAgents and mutate on refreshAgentDetection', async () => {
    useSWRMock.mockReturnValue({ data: [], error: null });
    refreshCustomAgentsMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useDetectedAgents());

    await act(async () => {
      await result.current.refreshAgentDetection();
    });

    expect(ipcBridge.acpConversation.refreshCustomAgents.invoke).toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledWith('detected-agents');
  });

  it('ignores error during refreshAgentDetection', async () => {
    useSWRMock.mockReturnValue({ data: [], error: null });
    refreshCustomAgentsMock.mockRejectedValue(new Error('Refresh failed'));

    const { result } = renderHook(() => useDetectedAgents());

    await act(async () => {
      await result.current.refreshAgentDetection();
    });

    // Should not throw or log error (hook ignores it)
    expect(ipcBridge.acpConversation.refreshCustomAgents.invoke).toHaveBeenCalled();
  });
});
