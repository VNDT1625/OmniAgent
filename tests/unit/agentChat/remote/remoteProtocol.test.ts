/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  parseRemoteStreamFrame,
  redactRemoteError,
  safeRemoteStreamUrl,
  validateRemoteEndpoint,
  validateRemoteHandshake,
} from '../../../../packages/desktop/src/process/experimentalCore/adapters/remote';

describe('Tomny remote protocol validation', () => {
  it('requires TLS except for an explicitly allowed loopback endpoint', () => {
    expect(() => validateRemoteEndpoint('http://example.test')).toThrow(/requires HTTPS/u);
    expect(validateRemoteEndpoint('http://127.0.0.1:9000', true).origin).toBe('http://127.0.0.1:9000');
  });

  it('rejects an incompatible gateway before sending a run', () => {
    expect(() =>
      validateRemoteHandshake({
        protocol: 'tomny-remote',
        version: 3,
        compatibleVersions: [2, 3],
        capabilities: {
          streaming: 'websocket',
          resume: true,
          permissions: true,
          cancellation: true,
          modelDiscovery: true,
        },
      })
    ).toThrow(/incompatible/u);
  });

  it('accepts a compatible gateway handshake', () => {
    expect(
      validateRemoteHandshake({
        protocol: 'tomny-remote',
        version: 2,
        compatibleVersions: [1, 2],
        capabilities: {
          streaming: 'websocket',
          resume: true,
          permissions: true,
          cancellation: true,
          modelDiscovery: true,
        },
      }).version
    ).toBe(2);
  });

  it('rejects malformed and negative-sequence stream frames', () => {
    expect(() => parseRemoteStreamFrame({ type: 'event', sequence: -1, event: { type: 'delta', text: 'x' } })).toThrow(
      /invalid/u
    );
    expect(() => parseRemoteStreamFrame({ type: 'event', sequence: 1, event: { type: 'unknown' } })).toThrow(
      /invalid/u
    );
  });

  it('prevents a gateway from redirecting stream tickets to another origin', () => {
    const base = new URL('https://gateway.example.test');
    expect(() => safeRemoteStreamUrl(base, 'wss://attacker.example/stream', 'ticket', 0)).toThrow(/origin/u);
    expect(safeRemoteStreamUrl(base, 'wss://gateway.example.test/stream', 'ticket', 7)).toContain('after=7');
  });

  it('redacts credential-shaped values and the resolved opaque secret', () => {
    const safe = redactRemoteError('authorization=Bearer-secret token: abc actual-value', 'actual-value');
    expect(safe).not.toContain('Bearer-secret');
    expect(safe).not.toContain('actual-value');
  });
});
