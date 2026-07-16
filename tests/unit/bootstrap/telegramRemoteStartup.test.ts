import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tunnel = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('@process/studio/cloudflareTunnel', () => ({
  startTunnel: tunnel.start,
  stopTunnel: tunnel.stop,
}));

describe('Telegram remote startup', () => {
  const originalSecret = process.env.AIONUI_TELEGRAM_REMOTE_SECRET;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.AIONUI_TELEGRAM_REMOTE_SECRET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalSecret === undefined) delete process.env.AIONUI_TELEGRAM_REMOTE_SECRET;
    else process.env.AIONUI_TELEGRAM_REMOTE_SECRET = originalSecret;
  });

  it('creates one inherited 256-bit secret and reuses it', async () => {
    const { prepareTelegramRemoteSecret } = await import('@/process/startup/telegramRemoteStartup');
    const first = prepareTelegramRemoteSecret();
    const second = prepareTelegramRemoteSecret();

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it('registers the HTTPS tunnel origin with aioncore', async () => {
    tunnel.start.mockResolvedValue({ ok: true, url: 'https://remote.trycloudflare.com' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const { startTelegramRemoteTunnel } = await import('@/process/startup/telegramRemoteStartup');

    await expect(startTelegramRemoteTunnel(43123, 'vi-VN')).resolves.toEqual({
      ok: true,
      url: 'https://remote.trycloudflare.com',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43123/api/channel/remote/public-url',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-aionui-remote-secret': expect.stringMatching(/^[a-f0-9]{64}$/) }),
        body: JSON.stringify({ public_url: 'https://remote.trycloudflare.com', language: 'vi-VN' }),
      })
    );
  });

  it('keeps Telegram grid controls when a tunnel cannot start', async () => {
    tunnel.start.mockResolvedValue({ ok: false, reason: 'not-installed' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { startTelegramRemoteTunnel } = await import('@/process/startup/telegramRemoteStartup');

    await expect(startTelegramRemoteTunnel(43123)).resolves.toEqual({ ok: false, reason: 'not-installed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
