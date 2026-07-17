/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CoreAdapterEvent } from '../coreAdapter';
import { TOMNY_REMOTE_PROTOCOL_VERSION, type RemoteHandshake, type RemoteStreamFrame } from './types';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export const validateRemoteEndpoint = (value: string, allowInsecureLoopback = false): URL => {
  const url = new URL(value);

  if (url.username || url.password) throw new Error('Remote endpoint must not contain inline credentials.');
  const secure = url.protocol === 'https:';
  const allowedLoopback = allowInsecureLoopback && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (!secure && !allowedLoopback) {
    throw new Error('Remote Tomny Core requires HTTPS, except explicitly allowed loopback development endpoints.');
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  return url;
};

export const validateRemoteHandshake = (value: unknown): RemoteHandshake => {
  if (!value || typeof value !== 'object') throw new Error('Remote handshake response is invalid.');
  const handshake = value as Partial<RemoteHandshake>;
  if (
    handshake.protocol !== 'tomny-remote' ||
    typeof handshake.version !== 'number' ||
    !Array.isArray(handshake.compatibleVersions) ||
    !handshake.compatibleVersions.every((version) => typeof version === 'number') ||
    !handshake.capabilities ||
    handshake.capabilities.streaming !== 'websocket' ||
    typeof handshake.capabilities.resume !== 'boolean' ||
    typeof handshake.capabilities.permissions !== 'boolean' ||
    typeof handshake.capabilities.cancellation !== 'boolean' ||
    typeof handshake.capabilities.modelDiscovery !== 'boolean'
  ) {
    throw new Error('Remote handshake response is invalid.');
  }
  const compatible =
    handshake.version === TOMNY_REMOTE_PROTOCOL_VERSION ||
    handshake.compatibleVersions.includes(TOMNY_REMOTE_PROTOCOL_VERSION);
  if (!compatible) {
    throw new Error(
      `Remote Tomny Core protocol is incompatible (remote ${handshake.version}, local ${TOMNY_REMOTE_PROTOCOL_VERSION}).`
    );
  }
  return handshake as RemoteHandshake;
};

const isAdapterEvent = (value: unknown): value is CoreAdapterEvent => {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<CoreAdapterEvent>;
  if (typeof event.type !== 'string') return false;
  if (event.type === 'delta') return typeof event.text === 'string';
  if (event.type === 'status' || event.type === 'thinking' || event.type === 'step') {
    return typeof event.text === 'string';
  }
  if (event.type === 'tool-call') return typeof event.text === 'string' && typeof event.tool === 'string';
  if (event.type === 'tool-result') {
    return (
      typeof event.text === 'string' &&
      typeof event.tool === 'string' &&
      (event.outcome === 'success' || event.outcome === 'error')
    );
  }
  return false;
};

const finiteSequence = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const parseRemoteStreamFrame = (value: unknown): RemoteStreamFrame => {
  if (!value || typeof value !== 'object') throw new Error('Remote stream frame is invalid.');
  const frame = value as Record<string, unknown>;
  if (frame.type === 'hello') {
    if (
      typeof frame.runId !== 'string' ||
      frame.protocolVersion !== TOMNY_REMOTE_PROTOCOL_VERSION ||
      (frame.sequence !== undefined && !finiteSequence(frame.sequence))
    ) {
      throw new Error('Remote stream hello frame is invalid.');
    }
    return frame as RemoteStreamFrame;
  }
  if (frame.type === 'event') {
    if (!finiteSequence(frame.sequence) || !isAdapterEvent(frame.event)) {
      throw new Error('Remote stream event frame is invalid.');
    }
    return frame as RemoteStreamFrame;
  }
  if (frame.type === 'permission') {
    if (
      !finiteSequence(frame.sequence) ||
      typeof frame.id !== 'string' ||
      typeof frame.tool !== 'string' ||
      (frame.detail !== undefined && typeof frame.detail !== 'string')
    ) {
      throw new Error('Remote permission frame is invalid.');
    }
    return frame as RemoteStreamFrame;
  }
  if (frame.type === 'completed' && finiteSequence(frame.sequence)) return frame as RemoteStreamFrame;
  if (
    frame.type === 'error' &&
    typeof frame.message === 'string' &&
    (frame.sequence === undefined || finiteSequence(frame.sequence))
  ) {
    return frame as RemoteStreamFrame;
  }
  throw new Error('Remote stream frame is invalid.');
};

export const safeRemoteStreamUrl = (base: URL, value: string, ticket: string, after: number): string => {
  const url = new URL(value, base);
  const expectedProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  if (url.protocol !== expectedProtocol || url.host !== base.host) {
    throw new Error('Remote stream URL must use the negotiated gateway origin.');
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  url.searchParams.set('ticket', ticket);
  url.searchParams.set('after', String(after));
  return url.toString();
};

const SECRET_FIELD_PATTERN =
  /((?:authorization|api.?key|access.?token|refresh.?token|password|secret|cookie)\s*[:=]\s*)([^\s,;]+)/giu;

export const redactRemoteError = (message: string, secret?: string): string => {
  let safe = message.replace(SECRET_FIELD_PATTERN, '$1[REDACTED]');
  if (secret) safe = safe.split(secret).join('[REDACTED]');
  return safe.slice(0, 2_000);
};
