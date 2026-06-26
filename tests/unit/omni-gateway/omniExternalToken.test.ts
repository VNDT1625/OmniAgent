/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the External Test Mode token store.
 *
 * Pure in-RAM logic (clock + token generator injected) so we can deterministically
 * exercise TTL expiry, call/bootstrap limits, and revocation without sleeping or
 * burning entropy.
 */

import { describe, expect, it } from 'vitest';
import {
  createOmniGatewayTokenStore,
  OMNI_DEBUG_TOKEN_DEFAULT_TTL_MS,
  OMNI_EXTERNAL_TOKEN_DEFAULT_TTL_MS,
} from '@/process/omni-gateway/omniGatewayExternalToken';

const newClock = (start = 0) => {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
};

const newGen = (prefix: string) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

const newStore = () => {
  const clock = newClock();
  const store = createOmniGatewayTokenStore({ now: clock.now, newToken: newGen('t') });
  return { store, clock };
};

describe('omniGatewayTokenStore — external bearer', () => {
  it('mints and validates a single external token', () => {
    const { store } = newStore();
    const t = store.mintExternalToken(1000);
    expect(t.token).toBe('t-1');
    expect(store.isExternalTokenValid('t-1')).toBe(true);
    expect(store.isExternalTokenValid('other')).toBe(false);
  });

  it('expires the external token after its TTL', () => {
    const { store, clock } = newStore();
    store.mintExternalToken(500);
    clock.advance(499);
    expect(store.isExternalTokenValid('t-1')).toBe(true);
    clock.advance(2);
    expect(store.isExternalTokenValid('t-1')).toBe(false);
    expect(store.getExternalToken()).toBeUndefined();
  });

  it('rotates: minting a second token replaces the first', () => {
    const { store } = newStore();
    store.mintExternalToken(1000);
    const next = store.mintExternalToken(1000);
    expect(next.token).toBe('t-2');
    expect(store.isExternalTokenValid('t-1')).toBe(false);
    expect(store.isExternalTokenValid('t-2')).toBe(true);
  });

  it('revokeExternalToken makes the token invalid immediately', () => {
    const { store } = newStore();
    store.mintExternalToken(1000);
    store.revokeExternalToken();
    expect(store.isExternalTokenValid('t-1')).toBe(false);
    expect(store.getExternalToken()).toBeUndefined();
  });
});

describe('omniGatewayTokenStore — debug URL tokens', () => {
  it('mints multiple debug tokens; each tracks its own caps', () => {
    const { store } = newStore();
    const a = store.mintDebugToken(1000);
    const b = store.mintDebugToken(1000);
    expect(a.token).not.toBe(b.token);
    expect(store.listDebugTokens()).toHaveLength(2);
  });

  it('expires debug tokens after their TTL', () => {
    const { store, clock } = newStore();
    const a = store.mintDebugToken(500);
    clock.advance(501);
    const verdict = store.checkDebugToken(a.token, false);
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) expect(verdict.reason).toBe('expired');
  });

  it('rejects an unknown token', () => {
    const { store } = newStore();
    const verdict = store.checkDebugToken('not-issued', false);
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) expect(verdict.reason).toBe('unknown');
  });

  it('uses no per-call cap by default — many calls succeed', () => {
    const { store } = newStore();
    const t = store.mintDebugToken(60_000);
    for (let i = 0; i < 250; i++) {
      expect(store.checkDebugToken(t.token, false).allow).toBe(true);
    }
  });

  it('uses no bootstrap cap by default — repeated bootstraps succeed', () => {
    const { store } = newStore();
    const t = store.mintDebugToken(60_000);
    for (let i = 0; i < 25; i++) {
      expect(store.checkDebugToken(t.token, true).allow).toBe(true);
    }
  });

  it('defaults to no TTL — debug + external tokens never expire by clock', () => {
    const { store, clock } = newStore();
    expect(OMNI_EXTERNAL_TOKEN_DEFAULT_TTL_MS).toBe(Number.POSITIVE_INFINITY);
    expect(OMNI_DEBUG_TOKEN_DEFAULT_TTL_MS).toBe(Number.POSITIVE_INFINITY);
    const ext = store.mintExternalToken();
    const dbg = store.mintDebugToken();
    clock.advance(1000 * 60 * 60 * 24 * 30); // jump 30 days
    expect(store.isExternalTokenValid(ext.token)).toBe(true);
    expect(store.checkDebugToken(dbg.token, false).allow).toBe(true);
  });

  it('revokeDebugToken removes one; revokeAll clears the rest', () => {
    const { store } = newStore();
    const a = store.mintDebugToken(1000);
    const b = store.mintDebugToken(1000);
    store.revokeDebugToken(a.token);
    expect(store.listDebugTokens()).toHaveLength(1);
    expect(store.checkDebugToken(a.token, false).allow).toBe(false);
    expect(store.checkDebugToken(b.token, false).allow).toBe(true);
    store.revokeAllDebugTokens();
    expect(store.listDebugTokens()).toHaveLength(0);
  });
});
