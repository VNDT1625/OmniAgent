import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  runAgentChatMessages: vi.fn(),
}));

vi.mock('@process/services/tomnyProviderBridge', () => ({
  getReadyProviderStore: vi.fn(async () => ({ list: mocks.list })),
}));
vi.mock('@process/services/agentChat', () => ({
  isCliModelId: (model: string) => model.startsWith('cli:'),
  runAgentChatMessages: mocks.runAgentChatMessages,
}));

import { createCompanyChat } from '@process/company/companyChat';

const provider = {
  id: 'provider-1',
  platform: 'openai',
  name: 'Provider',
  base_url: 'https://models.example/v1',
  api_key: 'secret',
  models: ['model-1'],
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([provider]);
});

describe('Company chat Tomny provider cutover', () => {
  it('reads provider configuration from the native store and calls the selected external model', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'planned' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await createCompanyChat()({
      model: 'model-1',
      messages: [{ role: 'user', content: 'Plan release' }],
    });

    expect(result).toBe('planned');
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('https://models.example/v1/chat/completions', expect.any(Object));
  });

  it('routes CLI assignments through the direct Tomny agent service without reading the provider store', async () => {
    mocks.runAgentChatMessages.mockResolvedValue('cli result');

    const result = await createCompanyChat()({
      model: 'cli:codex',
      messages: [{ role: 'user', content: 'Review' }],
    });

    expect(result).toBe('cli result');
    expect(mocks.runAgentChatMessages).toHaveBeenCalledOnce();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('fails clearly when the native store has no usable provider', async () => {
    mocks.list.mockResolvedValue([]);

    await expect(
      createCompanyChat()({ model: 'missing', messages: [{ role: 'user', content: 'Plan' }] })
    ).rejects.toThrow('No usable model is configured');
  });
});
