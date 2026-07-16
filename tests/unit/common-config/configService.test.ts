import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configService } from '@/common/config/configService';

const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('configService refresh', () => {
  beforeEach(() => {
    configService.reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    configService.reset();
  });

  it('publishes a Telegram model changed outside the renderer cache', async () => {
    const selected = { id: 'provider-2', use_model: 'model-b' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ 'assistant.telegram.defaultModel': selected })));
    const subscriber = vi.fn();
    configService.subscribe('assistant.telegram.defaultModel', subscriber);

    await configService.refresh('assistant.telegram.defaultModel');

    expect(configService.get('assistant.telegram.defaultModel')).toEqual(selected);
    expect(subscriber).toHaveBeenCalledWith(selected);
  });

  it('does not publish when the backend value has not changed', async () => {
    const selected = { id: 'provider-1', use_model: 'model-a' };
    configService.setLocal('assistant.telegram.defaultModel', selected);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ 'assistant.telegram.defaultModel': selected })));
    const subscriber = vi.fn();
    configService.subscribe('assistant.telegram.defaultModel', subscriber);

    await configService.refresh('assistant.telegram.defaultModel');

    expect(subscriber).not.toHaveBeenCalled();
  });

  it('keeps the cached model when refreshing fails', async () => {
    const selected = { id: 'provider-1', use_model: 'model-a' };
    configService.setLocal('assistant.telegram.defaultModel', selected);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(configService.refresh('assistant.telegram.defaultModel')).rejects.toThrow('offline');

    expect(configService.get('assistant.telegram.defaultModel')).toEqual(selected);
  });
});
