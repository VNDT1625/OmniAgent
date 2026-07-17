/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CoreAdapterEvent, DetectedCoreTarget } from '../coreAdapter';

export const TOMNY_REMOTE_PROTOCOL_VERSION = 1;

export type RemoteCredential = Readonly<{ scheme: 'bearer'; value: string }>;

export type RemoteCredentialProvider = {
  resolve(handle: string, request: { targetId: string; purpose: 'remote-core' }): Promise<RemoteCredential>;
};

export type RemoteTargetConnection = {
  endpoint: string;
  credentialHandle: string;
  allowInsecureLoopback?: boolean;
  mapWorkspace(localWorkspace: string): Promise<string>;
};

export type RemoteTargetResolver = {
  resolve(target: DetectedCoreTarget): Promise<RemoteTargetConnection>;
};

export type RemoteFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type RemoteSocketEvent = {
  data?: unknown;
};

export type RemoteSocket = {
  readyState: number;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: RemoteSocketEvent) => void): void;
  removeEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: RemoteSocketEvent) => void): void;
  close(code?: number, reason?: string): void;
};

export type RemoteSocketFactory = (url: string) => RemoteSocket;

export type RemoteHandshake = {
  protocol: 'tomny-remote';
  version: number;
  compatibleVersions: number[];
  capabilities: {
    streaming: 'websocket';
    resume: boolean;
    permissions: boolean;
    cancellation: boolean;
    modelDiscovery: boolean;
  };
};

export type RemoteModelRecord = {
  id: string;
  label?: string;
  providerId?: string;
  isDefault?: boolean;
};

export type RemoteStreamDescriptor = {
  runId: string;
  streamUrl: string;
  streamTicket: string;
  expiresAt?: number;
};

export type RemoteStreamFrame =
  | { type: 'hello'; protocolVersion: number; runId: string; sequence?: number }
  | { type: 'event'; sequence: number; event: CoreAdapterEvent }
  | { type: 'permission'; sequence: number; id: string; tool: string; detail?: string }
  | { type: 'completed'; sequence: number }
  | { type: 'error'; sequence?: number; message: string; retryable?: boolean };

export type RemoteAdapterOptions = {
  fetchImpl?: RemoteFetch;
  socketFactory?: RemoteSocketFactory;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  maxReconnects?: number;
  handshakeTimeoutMs?: number;

  streamIdleTimeoutMs?: number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
};
