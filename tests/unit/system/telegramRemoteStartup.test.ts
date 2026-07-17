import { beforeEach, describe, expect, it, vi } from 'vitest';

const tunnelMocks = vi.hoisted(() => ({
  startTunnel: vi.fn(),
  stopTunnel: vi.fn(),
}));

vi.mock('@process/studio/cloudflareTunnel', () => ({
  startTunnel: tunnelMocks.startTunnel,
  stopTunnel: tunnelMocks.stopTunnel,
}));

describe('Telegram remote startup', () => {
  beforeEach(() => {
    vi.resetModules();
    tunnelMocks.startTunnel.mockReset();
    tunnelMocks.stopTunnel.mockReset();
    vi.unstubAllGlobals();
  });

  it('publishes the existing tunnel URL again when aioncore becomes ready again', async () => {
    tunnelMocks.startTunnel.mockResolvedValue({ ok: true, url: 'https://remote.trycloudflare.com' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const { startTelegramRemoteTunnel } = await import('@process/startup/telegramRemoteStartup');
    await startTelegramRemoteTunnel(4100, 'vi-VN');
    await startTelegramRemoteTunnel(4200, 'vi-VN');

    expect(tunnelMocks.startTunnel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4200/api/channel/remote/public-url',
      expect.objectContaining({
        body: JSON.stringify({
          public_url: 'https://remote.trycloudflare.com',
          language: 'vi-VN',
        }),
      })
    );
  });

  it('allows tunnel startup to retry after a failed attempt', async () => {
    tunnelMocks.startTunnel
      .mockResolvedValueOnce({ ok: false, reason: 'timeout' })
      .mockResolvedValueOnce({ ok: true, url: 'https://retry.trycloudflare.com' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    const { startTelegramRemoteTunnel } = await import('@process/startup/telegramRemoteStartup');
    await expect(startTelegramRemoteTunnel(4100)).resolves.toEqual({ ok: false, reason: 'timeout' });
    await expect(startTelegramRemoteTunnel(4100)).resolves.toEqual({
      ok: true,
      url: 'https://retry.trycloudflare.com',
    });

    expect(tunnelMocks.startTunnel).toHaveBeenCalledTimes(2);
  });
});
