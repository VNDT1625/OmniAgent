import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const buildProviderMock = vi.fn((channel: string) => ({
  invoke: (input?: unknown) => invokeMock(channel, input),
}));

vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: buildProviderMock,
  },
}));

const importClient = async () => {
  vi.resetModules();
  return import('@/renderer/services/agentMeshClient');
};

describe('agentMeshClient', () => {
  afterEach(() => {
    invokeMock.mockReset();
    buildProviderMock.mockClear();
    vi.useRealTimers();
  });

  it('creates a mesh session through the main-process IPC contract', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, data: 'runtime-request' });
    const { agentMeshClient } = await importClient();

    await expect(agentMeshClient.create('runtime-request')).resolves.toEqual({
      ok: true,
      data: 'runtime-request',
    });
    expect(invokeMock).toHaveBeenCalledWith('agent-mesh.create', { sessionId: 'runtime-request' });
  });

  it('fails fast when the create provider is unavailable', async () => {
    vi.useFakeTimers();
    invokeMock.mockReturnValueOnce(new Promise(() => undefined));
    const { agentMeshClient } = await importClient();

    const pending = expect(agentMeshClient.create('missing')).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(4_000);
    await pending;
  });
});
