import { describe, expect, it, vi } from 'vitest';
import {
  detectProviderProtocol,
  fetchProviderModelList,
} from '../../../packages/desktop/src/process/services/tomnyModelDiscovery';

describe('Tomny direct model discovery', () => {
  it('lists OpenAI-compatible models directly with bearer authentication', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'gpt-5.6' }, { id: 'gpt-5.5' }],
          }),
          { status: 200 }
        )
    ) as typeof fetch;
    const result = await fetchProviderModelList(
      {
        platform: 'openai',
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-test',
      },
      fetchImpl
    );
    expect(result.models).toEqual(['gpt-5.6', 'gpt-5.5']);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-test' } })
    );
  });

  it('normalizes Gemini model names and verifies the protocol without AionCore', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            models: [{ name: 'models/gemini-2.5-pro' }],
          }),
          { status: 200 }
        )
    ) as typeof fetch;
    const result = await detectProviderProtocol(
      {
        base_url: 'https://generativelanguage.googleapis.com',
        api_key: 'AIza-test',
        preferredProtocol: 'gemini',
      },
      fetchImpl
    );
    expect(result).toMatchObject({
      success: true,
      protocol: 'gemini',
      models: ['gemini-2.5-pro'],
    });
  });
});
