import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getContext, updateContext } = vi.hoisted(() => ({
  getContext: vi.fn(),
  updateContext: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      getAionrsContext: { invoke: getContext },
      updateAionrsContext: { invoke: updateContext },
    },
  },
}));

import { useAionrsContext } from '@/renderer/pages/studio/ide/memory/useAionrsContext';

const snapshot = {
  model: 'test-model',
  system: '',
  messages: [],
  tools: [],
  max_tokens: 4096,
  thinking: null,
  custom_context: '',
  context_branches: [],
  active_context_branch_ids: [],
  working_memory: {},
  full_message_count: 0,
  tool_cache: {},
  session_experience: {},
  token_estimate: { system: 0, messages: 0, tools: 0, total: 0 },
};

describe('useAionrsContext', () => {
  beforeEach(() => {
    getContext.mockReset().mockResolvedValue(snapshot);
    updateContext.mockReset().mockResolvedValue(snapshot);
  });

  it('persists custom context and context branches in one atomic request', async () => {
    const { result, unmount } = renderHook(() => useAionrsContext('conversation-1', true));
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshot));

    const branches = [{ id: 'mcp-web', title: 'MCP web', summary: 'integration', content: 'rules' }];
    await act(async () => {
      await result.current.save('concise', branches);
    });

    expect(updateContext).toHaveBeenCalledWith({
      conversation_id: 'conversation-1',
      custom_context: 'concise',
      context_branches: branches,
    });
    unmount();
  });
});
