/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteCoreTarget,
  RemoteCoreAdapter,
  type RemoteSocket,
  type RemoteSocketEvent,
} from '../../../../packages/desktop/src/process/experimentalCore/adapters/remote';
import type { CoreRunInput } from '../../../../packages/desktop/src/process/experimentalCore/adapters';

class FakeSocket implements RemoteSocket {
  public readyState = 1;
  public closed = false;
  private readonly listeners = new Map<string, Set<(event: RemoteSocketEvent) => void>>();

  public addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: RemoteSocketEvent) => void
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: RemoteSocketEvent) => void
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  public close(): void {
    this.closed = true;
  }

  public emit(type: 'open' | 'message' | 'close' | 'error', value?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: value });
  }

  public frame(value: unknown): void {
    this.emit('message', JSON.stringify(value));
  }
}

const handshake = {
  protocol: 'tomny-remote',
  version: 1,
  compatibleVersions: [1],
  capabilities: {
    streaming: 'websocket',
    resume: true,
    permissions: true,
    cancellation: true,
    modelDiscovery: true,
  },
};

const json = (value: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

const target = createRemoteCoreTarget({ id: 'remote-work', name: 'Remote Work' });

const makeInput = (overrides: Partial<CoreRunInput> = {}): CoreRunInput => ({
  sessionId: 'session-1',
  target,
  prompt: 'Inspect the project',
  workspace: 'C:\\work\\project',
  modelKey: 'model-a',
  permissionMode: 'workspace-write',
  signal: new AbortController().signal,
  emit: vi.fn(),
  requestPermission: vi.fn(async () => true),
  ...overrides,
});

const resolver = {
  resolve: vi.fn(async () => ({
    endpoint: 'https://gateway.test',
    credentialHandle: 'secret://remote-token',
    mapWorkspace: async () => 'workspace/project',
  })),
};

const credentials = {
  resolve: vi.fn(async () => ({ scheme: 'bearer' as const, value: 'private-bearer-token' })),
};

describe('RemoteCoreAdapter', () => {
  it('discovers normalized models through a versioned authenticated handshake', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer private-bearer-token' });
      if (url.endsWith('/v1/handshake')) return json(handshake);
      if (url.endsWith('/v1/models')) {
        return json({
          models: [
            { id: 'model-a', label: 'Model A', providerId: 'provider', isDefault: true },
            { id: 'model-a', label: 'duplicate' },
            { id: '' },
          ],
        });
      }
      return json({ error: 'unexpected' }, { status: 404 });
    });
    const adapter = new RemoteCoreAdapter(resolver, credentials, { fetchImpl });

    await expect(adapter.listModels(target)).resolves.toEqual([
      {
        key: 'model-a',
        modelId: 'model-a',
        label: 'Model A',
        providerId: 'provider',
        isDefault: true,
      },
    ]);
    expect(credentials.resolve).toHaveBeenCalledWith('secret://remote-token', {
      targetId: 'remote-work',
      purpose: 'remote-core',
    });
  });

  it('streams events, relays permission decisions and completes without legacy core', async () => {
    const permissionBodies: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/handshake')) return json(handshake);
      if (url.endsWith('/v1/runs') && init?.method === 'POST') {
        return json({ runId: 'run-1', streamUrl: 'wss://gateway.test/stream', streamTicket: 'ticket-1' });
      }
      if (url.includes('/permissions/permission-1')) {
        permissionBodies.push(JSON.parse(String(init?.body)));
        return json({ ok: true });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ error: 'unexpected' }, { status: 404 });
    });
    const socket = new FakeSocket();
    const socketFactory = vi.fn(() => {
      queueMicrotask(() => {
        socket.emit('open');
        socket.frame({ type: 'hello', protocolVersion: 1, runId: 'run-1', sequence: 0 });
        socket.frame({ type: 'event', sequence: 1, event: { type: 'delta', text: 'Hello', mode: 'append' } });
        socket.frame({ type: 'permission', sequence: 2, id: 'permission-1', tool: 'tomny_edit', detail: 'a.ts' });
        setTimeout(() => socket.frame({ type: 'completed', sequence: 3 }), 0);
      });
      return socket;
    });
    const input = makeInput();
    const adapter = new RemoteCoreAdapter(resolver, credentials, { fetchImpl, socketFactory });

    await adapter.run(input);

    expect(input.emit).toHaveBeenCalledWith({ type: 'delta', text: 'Hello', mode: 'append' });
    expect(input.requestPermission).toHaveBeenCalledWith({ tool: 'tomny_edit', detail: 'a.ts' });
    expect(permissionBodies).toEqual([{ approved: true }]);
  });

  it('resumes from the last contiguous sequence after a transport disconnect', async () => {
    let resumeAfter: unknown;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/handshake')) return json(handshake);
      if (url.endsWith('/v1/runs') && init?.method === 'POST') {
        return json({ runId: 'run-2', streamUrl: 'wss://gateway.test/stream', streamTicket: 'ticket-1' });
      }
      if (url.endsWith('/v1/runs/run-2/resume')) {
        resumeAfter = JSON.parse(String(init?.body));
        return json({ runId: 'run-2', streamUrl: 'wss://gateway.test/stream', streamTicket: 'ticket-2' });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ error: 'unexpected' }, { status: 404 });
    });
    const sockets = [new FakeSocket(), new FakeSocket()];
    const socketFactory = vi.fn(() => {
      const index = socketFactory.mock.calls.length - 1;
      const socket = sockets[index];
      queueMicrotask(() => {
        socket.emit('open');
        socket.frame({ type: 'hello', protocolVersion: 1, runId: 'run-2', sequence: index });
        if (index === 0) {
          socket.frame({ type: 'event', sequence: 1, event: { type: 'delta', text: 'A' } });
          socket.emit('close');
        } else {
          socket.frame({ type: 'event', sequence: 2, event: { type: 'delta', text: 'B' } });
          socket.frame({ type: 'completed', sequence: 3 });
        }
      });
      return socket;
    });
    const input = makeInput();
    const adapter = new RemoteCoreAdapter(resolver, credentials, {
      fetchImpl,
      socketFactory,
      sleep: async () => undefined,
    });

    await adapter.run(input);

    expect(resumeAfter).toEqual({ after: 1 });
    expect(input.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'status', text: expect.stringContaining('reconnecting') })
    );
    expect(input.emit).toHaveBeenCalledWith({ type: 'delta', text: 'B' });
  });

  it('cancels both the socket and remote run when the caller aborts', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/handshake')) return json(handshake);
      if (url.endsWith('/v1/runs') && init?.method === 'POST') {
        return json({ runId: 'run-3', streamUrl: 'wss://gateway.test/stream', streamTicket: 'ticket' });
      }
      if (url.endsWith('/v1/runs/run-3') && init?.method === 'DELETE') {
        cancelled = true;
        return new Response(null, { status: 204 });
      }
      return json({ error: 'unexpected' }, { status: 404 });
    });
    const socket = new FakeSocket();
    const adapter = new RemoteCoreAdapter(resolver, credentials, {
      fetchImpl,
      socketFactory: () => {
        queueMicrotask(() => controller.abort());
        return socket;
      },
    });

    await expect(adapter.run(makeInput({ signal: controller.signal }))).rejects.toThrow(/cancelled/u);
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(socket.closed).toBe(true);
  });

  it('turns a silent stream into a bounded reconnect failure instead of hanging forever', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/handshake')) return json(handshake);
      if (url.endsWith('/v1/runs') && init?.method === 'POST') {
        return json({ runId: 'run-silent', streamUrl: 'wss://gateway.test/stream', streamTicket: 'ticket' });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ error: 'unexpected' }, { status: 404 });
    });
    const socket = new FakeSocket();
    const adapter = new RemoteCoreAdapter(resolver, credentials, {
      fetchImpl,
      socketFactory: () => socket,
      streamIdleTimeoutMs: 1,
      maxReconnects: 0,
    });

    await expect(adapter.run(makeInput())).rejects.toThrow(/disconnected/u);
    expect(socket.closed).toBe(true);
  });

  it('never leaks a resolved credential when the gateway echoes it in an error', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'authorization=private-bearer-token' }, { status: 401 }));
    const adapter = new RemoteCoreAdapter(resolver, credentials, { fetchImpl });

    await expect(adapter.listModels(target)).rejects.not.toThrow(/private-bearer-token/u);
  });
});
