/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExperimentalCoreModel } from '../../experimentalCoreProtocol';
import {
  requireWorkspace,
  throwIfAborted,
  type CoreAdapter,
  type CoreRunInput,
  type DetectedCoreTarget,
} from '../coreAdapter';
import {
  parseRemoteStreamFrame,
  safeRemoteStreamUrl,
  validateRemoteEndpoint,
  validateRemoteHandshake,
} from './protocol';
import { RemoteGatewayClient } from './transport';
import {
  TOMNY_REMOTE_PROTOCOL_VERSION,
  type RemoteAdapterOptions,
  type RemoteCredentialProvider,
  type RemoteSocket,
  type RemoteSocketEvent,
  type RemoteStreamDescriptor,
  type RemoteTargetResolver,
} from './types';

const DEFAULT_RECONNECT_BASE_DELAY_MS = 500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 8_000;
const DEFAULT_MAX_RECONNECTS = 5;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45_000;

const defaultSocketFactory = (url: string): RemoteSocket => {
  const SocketConstructor = (globalThis as { WebSocket?: new (value: string) => RemoteSocket }).WebSocket;
  if (!SocketConstructor) throw new Error('WebSocket is unavailable in this runtime.');
  return new SocketConstructor(url);
};

const defaultSleep = (delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('The request was cancelled.'));
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('The request was cancelled.'));
      },
      { once: true }
    );
  });

const assertDescriptor = (value: RemoteStreamDescriptor): RemoteStreamDescriptor => {
  if (
    !value ||
    typeof value.runId !== 'string' ||
    !value.runId ||
    typeof value.streamUrl !== 'string' ||
    typeof value.streamTicket !== 'string' ||
    !value.streamTicket
  ) {
    throw new Error('Remote run descriptor is invalid.');
  }
  return value;
};

type ConsumeResult = { completed: boolean; sequence: number };

export class RemoteCoreAdapter implements CoreAdapter {
  public readonly protocol = 'tomny-remote-v1' as const;
  private readonly activeCancels = new Set<() => void>();
  private readonly fetchImpl;
  private readonly socketFactory;
  private readonly reconnectBaseDelayMs;
  private readonly reconnectMaxDelayMs;
  private readonly maxReconnects;
  private readonly handshakeTimeoutMs;

  private readonly streamIdleTimeoutMs;
  private readonly sleep;

  public constructor(
    private readonly targetResolver: RemoteTargetResolver,
    private readonly credentialProvider: RemoteCredentialProvider,
    options: RemoteAdapterOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    this.maxReconnects = options.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  private async clientFor(target: DetectedCoreTarget): Promise<{ client: RemoteGatewayClient; base: URL }> {
    const connection = await this.targetResolver.resolve(target);
    const base = validateRemoteEndpoint(connection.endpoint, connection.allowInsecureLoopback);
    const credential = await this.credentialProvider.resolve(connection.credentialHandle, {
      targetId: target.id,
      purpose: 'remote-core',
    });
    if (credential.scheme !== 'bearer' || !credential.value) {
      throw new Error('Remote credential capability returned an unsupported credential.');
    }
    return {
      client: new RemoteGatewayClient(base, credential, this.fetchImpl, this.handshakeTimeoutMs),
      base,
    };
  }

  public async listModels(target: DetectedCoreTarget): Promise<ExperimentalCoreModel[]> {
    const { client } = await this.clientFor(target);
    validateRemoteHandshake(await client.handshake());
    const seen = new Set<string>();
    return (await client.listModels())
      .filter((model) => Boolean(model.id.trim()) && !seen.has(model.id.trim()) && seen.add(model.id.trim()))
      .map((model) => ({
        key: model.id.trim(),
        modelId: model.id.trim(),
        label: model.label?.trim() || model.id.trim(),
        providerId: model.providerId?.trim() || undefined,
        isDefault: model.isDefault === true,
      }));
  }

  public async run(input: CoreRunInput): Promise<void> {
    throwIfAborted(input.signal);
    const connection = await this.targetResolver.resolve(input.target);
    const base = validateRemoteEndpoint(connection.endpoint, connection.allowInsecureLoopback);
    const credential = await this.credentialProvider.resolve(connection.credentialHandle, {
      targetId: input.target.id,
      purpose: 'remote-core',
    });
    if (credential.scheme !== 'bearer' || !credential.value) {
      throw new Error('Remote credential capability returned an unsupported credential.');
    }
    const client = new RemoteGatewayClient(base, credential, this.fetchImpl, this.handshakeTimeoutMs);
    const handshake = validateRemoteHandshake(await client.handshake(input.signal));
    const workspace = await connection.mapWorkspace(requireWorkspace(input.workspace));
    if (!workspace.trim()) throw new Error('Remote workspace mapping returned an empty workspace identifier.');

    let descriptor = assertDescriptor(
      await client.startRun(
        {
          sessionId: input.sessionId,
          prompt: input.prompt,
          workspace,
          modelKey: input.modelKey,
          permissionMode: input.permissionMode,
          protocolVersion: TOMNY_REMOTE_PROTOCOL_VERSION,
        },
        input.signal
      )
    );
    let sequence = 0;
    let reconnects = 0;
    let activeSocket: RemoteSocket | null = null;
    const cancel = (): void => {
      activeSocket?.close(1000, 'cancelled');
      void client.cancelRun(descriptor.runId).catch((): undefined => undefined);
    };
    this.activeCancels.add(cancel);
    input.signal.addEventListener('abort', cancel, { once: true });

    try {
      // oxlint-disable no-await-in-loop -- reconnect attempts intentionally depend on prior stream state.

      while (true) {
        throwIfAborted(input.signal);
        const streamUrl = safeRemoteStreamUrl(base, descriptor.streamUrl, descriptor.streamTicket, sequence);
        const socket = this.socketFactory(streamUrl);
        activeSocket = socket;

        const result = await this.consumeSocket(socket, descriptor.runId, sequence, client, input);
        sequence = result.sequence;
        if (result.completed) return;
        throwIfAborted(input.signal);
        if (!handshake.capabilities.resume || reconnects >= this.maxReconnects) {
          throw new Error('Remote stream disconnected before completion.');
        }
        while (true) {
          const delay = Math.min(this.reconnectBaseDelayMs * 2 ** reconnects, this.reconnectMaxDelayMs);
          reconnects += 1;
          input.emit({ type: 'status', text: `Remote stream interrupted; reconnecting (${reconnects}).` });
          await this.sleep(delay, input.signal);
          try {
            descriptor = assertDescriptor(await client.resumeRun(descriptor.runId, sequence, input.signal));
            break;
          } catch (error) {
            throwIfAborted(input.signal);
            if (reconnects >= this.maxReconnects) throw error;
            input.emit({ type: 'status', text: 'Remote resume request failed; retrying safely.' });
          }
        }
      }
      // oxlint-enable no-await-in-loop
    } finally {
      input.signal.removeEventListener('abort', cancel);
      this.activeCancels.delete(cancel);
      activeSocket?.close();
    }
  }

  private consumeSocket(
    socket: RemoteSocket,
    runId: string,
    initialSequence: number,
    client: RemoteGatewayClient,
    input: CoreRunInput
  ): Promise<ConsumeResult> {
    return new Promise((resolve, reject) => {
      let sequence = initialSequence;
      let settled = false;
      let helloReceived = false;
      let messageQueue = Promise.resolve();

      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const resetIdleTimer = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          socket.close(1012, 'idle-timeout');
          finish({ completed: false, sequence });
        }, this.streamIdleTimeoutMs);
      };
      const finish = (result?: ConsumeResult, error?: Error): void => {
        if (settled) return;
        settled = true;

        if (idleTimer) clearTimeout(idleTimer);
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('close', onClose);
        socket.removeEventListener('error', onError);
        input.signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(result ?? { completed: false, sequence });
      };
      const onClose = (): void => {
        void messageQueue.then(() => finish({ completed: false, sequence }));
      };
      const onError = (): void => {
        socket.close(1012, 'transport-error');
        finish({ completed: false, sequence });
      };
      const onAbort = (): void => {
        socket.close(1000, 'cancelled');
        finish(undefined, new Error('The request was cancelled.'));
      };
      const handleFrame = async (event: RemoteSocketEvent): Promise<void> => {
        if (settled) return;
        const raw = typeof event.data === 'string' ? event.data : String(event.data ?? '');
        const frame = parseRemoteStreamFrame(JSON.parse(raw) as unknown);
        if (frame.type === 'hello') {
          if (frame.runId !== runId) throw new Error('Remote stream run identity does not match.');
          helloReceived = true;
          return;
        }
        if (!helloReceived) throw new Error('Remote stream emitted data before its hello frame.');
        const frameSequence = frame.sequence ?? sequence;
        if (frameSequence <= sequence) return;
        if (frameSequence !== sequence + 1) {
          socket.close(1012, 'sequence-gap');
          finish({ completed: false, sequence });
          return;
        }
        sequence = frameSequence;
        if (frame.type === 'event') {
          input.emit(frame.event);
          return;
        }
        if (frame.type === 'permission') {
          const approved = await input.requestPermission({ tool: frame.tool, detail: frame.detail });
          await client.answerPermission(runId, frame.id, approved, input.signal);
          return;
        }
        if (frame.type === 'completed') {
          finish({ completed: true, sequence });
          return;
        }
        if (frame.type === 'error') {
          if (frame.retryable === true) {
            socket.close(1012, 'retryable-error');
            finish({ completed: false, sequence });
            return;
          }
          finish(undefined, new Error(frame.message));
        }
      };
      const onMessage = (event: RemoteSocketEvent): void => {
        resetIdleTimer();
        messageQueue = messageQueue
          .then(() => handleFrame(event))
          .catch((error) => finish(undefined, error instanceof Error ? error : new Error(String(error))));
      };

      resetIdleTimer();

      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', onClose);
      socket.addEventListener('error', onError);
      input.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  public async dispose(): Promise<void> {
    for (const cancel of this.activeCancels) cancel();
    this.activeCancels.clear();
  }
}
