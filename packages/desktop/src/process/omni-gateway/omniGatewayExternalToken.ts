/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-RAM short-TTL token store for the Omni External MCP Gateway's two
 * "public" planes:
 *
 *  1. **External MCP Token** — Bearer presented on `/ide/mcp` requests that
 *     arrive via the Cloudflare Quick Tunnel. One token at a time; TTL ~30
 *     minutes; user-revocable at any moment from Settings.
 *
 *  2. **Debug Bridge Token** — URL query parameter (?token=…) used by browser
 *     AIs (ChatGPT, Grok) that cannot send custom headers from their web tool.
 *     TTL ~15 minutes; capped at 50 total calls and 3 bootstrap calls; the
 *     Settings UI generates and revokes these on demand.
 *
 * Both planes use an injectable `now`/`newId` so unit tests are deterministic.
 * Nothing here ever touches disk.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

/**
 * Defaults — both planes live until the user explicitly disables / rotates /
 * revokes them. There is no TTL or call cap by default: external host runs
 * inside the same in-app gateway as a local client and only touches the same
 * IDE tools the local agent already uses. Stopping Web Access (one click in
 * Settings) is the kill switch.
 *
 * Callers MAY still pass a finite TTL for ad-hoc short-lived tokens, but the
 * Settings UI mints with the unbounded default.
 */
export const OMNI_EXTERNAL_TOKEN_DEFAULT_TTL_MS = Number.POSITIVE_INFINITY;
export const OMNI_DEBUG_TOKEN_DEFAULT_TTL_MS = Number.POSITIVE_INFINITY;
/** Per-token call caps are disabled by default; left as constants so callers can opt in. */
export const OMNI_DEBUG_TOKEN_MAX_CALLS = Number.POSITIVE_INFINITY;
export const OMNI_DEBUG_TOKEN_MAX_BOOTSTRAP_CALLS = Number.POSITIVE_INFINITY;

/** A live external (Bearer) token. */
export type ExternalToken = {
  /** The raw 32-byte hex string presented in the Authorization header. */
  token: string;
  /** Wall-clock ms when issued. */
  issuedAt: number;
  /** Wall-clock ms after which the token MUST NOT be accepted. */
  expiresAt: number;
};

/** A live debug-bridge token bound to per-endpoint usage caps. */
export type DebugToken = {
  /** The raw 32-byte hex string passed as `?token=`. */
  token: string;
  /** Wall-clock ms when issued. */
  issuedAt: number;
  /** Wall-clock ms after which the token MUST NOT be accepted. */
  expiresAt: number;
  /** Total successful calls (excluding 4xx denials) so far. */
  callCount: number;
  /** Successful bootstrap calls so far. */
  bootstrapCount: number;
};

/** Verdict returned by {@link OmniGatewayTokenStore.checkDebugToken}. */
export type DebugTokenVerdict =
  | { allow: true; token: DebugToken }
  | { allow: false; reason: 'unknown' | 'expired' | 'rate-limit' | 'bootstrap-limit' };

/** Injected dependencies for {@link createOmniGatewayTokenStore}. */
export type OmniGatewayTokenStoreDeps = {
  now: () => number;
  newToken: () => string;
};

/** Public API of the token store. */
export type OmniGatewayTokenStore = {
  // External MCP token (Bearer)
  mintExternalToken: (ttlMs?: number) => ExternalToken;
  getExternalToken: () => ExternalToken | undefined;
  revokeExternalToken: () => void;
  isExternalTokenValid: (presented: string) => boolean;

  // Debug Bridge token (URL ?token=)
  mintDebugToken: (ttlMs?: number) => DebugToken;
  listDebugTokens: () => DebugToken[];
  revokeDebugToken: (token: string) => void;
  revokeAllDebugTokens: () => void;
  /**
   * Validate a debug token and account one call against its limits. `isBootstrap`
   * routes to the dedicated bootstrap counter so a burst of `/debug/omni/search`
   * calls doesn't exhaust the (smaller) bootstrap budget.
   */
  checkDebugToken: (token: string, isBootstrap: boolean) => DebugTokenVerdict;
};

/** Build a fresh token store with the injected clock + id generator. */
export const createOmniGatewayTokenStore = (deps: OmniGatewayTokenStoreDeps): OmniGatewayTokenStore => {
  let externalToken: ExternalToken | undefined;
  const debugTokens = new Map<string, DebugToken>();

  const sweepExpired = (): void => {
    const now = deps.now();
    if (externalToken && externalToken.expiresAt <= now) externalToken = undefined;
    for (const [k, t] of debugTokens) {
      if (t.expiresAt <= now) debugTokens.delete(k);
    }
  };

  return {
    mintExternalToken: (ttlMs = OMNI_EXTERNAL_TOKEN_DEFAULT_TTL_MS) => {
      const now = deps.now();
      externalToken = { token: deps.newToken(), issuedAt: now, expiresAt: now + ttlMs };
      return externalToken;
    },
    getExternalToken: () => {
      sweepExpired();
      return externalToken;
    },
    revokeExternalToken: () => {
      externalToken = undefined;
    },
    isExternalTokenValid: (presented) => {
      sweepExpired();
      return externalToken !== undefined && presented === externalToken.token;
    },

    mintDebugToken: (ttlMs = OMNI_DEBUG_TOKEN_DEFAULT_TTL_MS) => {
      const now = deps.now();
      const debug: DebugToken = {
        token: deps.newToken(),
        issuedAt: now,
        expiresAt: now + ttlMs,
        callCount: 0,
        bootstrapCount: 0,
      };
      debugTokens.set(debug.token, debug);
      return debug;
    },
    listDebugTokens: () => {
      sweepExpired();
      return Array.from(debugTokens.values());
    },
    revokeDebugToken: (token) => {
      debugTokens.delete(token);
    },
    revokeAllDebugTokens: () => debugTokens.clear(),
    checkDebugToken: (token, isBootstrap) => {
      const entry = debugTokens.get(token);
      if (!entry) return { allow: false, reason: 'unknown' };
      if (entry.expiresAt <= deps.now()) {
        debugTokens.delete(token);
        return { allow: false, reason: 'expired' };
      }
      // Sweep other expired entries opportunistically — does not affect
      // THIS verdict (we already validated the presented token above).
      sweepExpired();
      if (entry.callCount >= OMNI_DEBUG_TOKEN_MAX_CALLS) {
        return { allow: false, reason: 'rate-limit' };
      }
      if (isBootstrap && entry.bootstrapCount >= OMNI_DEBUG_TOKEN_MAX_BOOTSTRAP_CALLS) {
        return { allow: false, reason: 'bootstrap-limit' };
      }
      entry.callCount++;
      if (isBootstrap) entry.bootstrapCount++;
      return { allow: true, token: entry };
    },
  };
};
