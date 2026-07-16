/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared Node-safe runtime for the Omni External MCP Gateway.
 *
 * The Electron app and standalone rescue sidecar both call this module so they
 * bind the same `/ide/mcp` host, auth gate, OAuth handler, session guard, tool
 * permissions, debug bridge, and public tunnel behavior. App/rescue adapters
 * provide persistence and IDE deps; this runtime owns only live process state.
 *
 * Process boundary: Main-process / standalone Node.js. No DOM APIs.
 */

import { randomBytes } from 'node:crypto';
import type { IdeServerDeps } from '@process/ide/mcp/ideServer';
import { buildOmniIdeServer } from './omniGatewayProfile';
import { createOmniGatewayState, type OmniGatewayState } from './omniGatewayState';
import { startOmniGatewayHost, type OmniGatewayHost } from './omniGatewayHost';
import {
  createOmniGatewayTokenStore,
  OMNI_EXTERNAL_TOKEN_DEFAULT_TTL_MS,
  type ExternalToken,
  type OmniGatewayTokenStore,
} from './omniGatewayExternalToken';
import { createOmniDebugBridge } from './omniGatewayDebugBridge';
import { startOmniTunnel, stopOmniTunnel, type StartOmniTunnelResult } from './omniGatewayTunnel';
import { createOmniOAuthHandler, type OmniOAuthHandler } from './auth/omniGatewayOAuth';
import type { OmniOAuthStore } from './auth/omniGatewayOAuthStore';
import { OMNI_DEFAULT_AUTH_MODE, type OmniAuthMode, type OmniToolPermissions } from './auth/authTypes';
import type { OmniSecurityState } from './auth/omniGatewaySecurityStore';
import type { OmniGatewayProgressPhase } from './omniGatewayProgress';

export const OMNI_GATEWAY_DEFAULT_PORT = 47821;
export const OMNI_GATEWAY_DEFAULT_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
export const OMNI_GATEWAY_TOKEN_BYTES = 32;

export type OmniGatewayRuntimeConfig = {
  port: number;
  rootPath?: string;
  allowDangerous: boolean;
  externalMode?: { enabled: boolean };
};

export type LiveOmniGateway = {
  host: OmniGatewayHost;
  state: OmniGatewayState;
  tokenStore: OmniGatewayTokenStore;
};

export type LiveOmniGatewayExternal = {
  tunnelUrl: string;
  bearerToken: ExternalToken;
};

export type OmniGatewayRuntimeSnapshot = {
  live?: LiveOmniGateway;
  liveExternal?: LiveOmniGatewayExternal;
  lastError?: string;
  authMode: OmniAuthMode;
  toolPermissions: OmniToolPermissions;
};

export type OmniGatewayRuntimeDeps = {
  loadSecurityState: () => Promise<OmniSecurityState>;
  oauth: () => OmniOAuthStore;
  buildIdeDeps: () => Omit<IdeServerDeps, 'toolGuard'>;
  emitProgress?: (
    phase: OmniGatewayProgressPhase,
    detail?: { message?: string; tunnelUrl?: string; error?: string }
  ) => void;
  now?: () => number;
  newToken?: () => string;
  newId?: () => string;
};

export type OmniGatewayRuntime = {
  start: (cfg: OmniGatewayRuntimeConfig, localBearerToken: string) => Promise<void>;
  stop: () => Promise<void>;
  startExternalAccess: () => Promise<LiveOmniGatewayExternal>;
  disableExternalAccess: () => void;
  snapshot: () => OmniGatewayRuntimeSnapshot;
  setAuthMode: (mode: OmniAuthMode) => void;
  setToolPermissions: (permissions: OmniToolPermissions) => void;
};

export const createOmniGatewayRuntime = (deps: OmniGatewayRuntimeDeps): OmniGatewayRuntime => {
  let live: LiveOmniGateway | undefined;
  let liveExternal: LiveOmniGatewayExternal | undefined;
  let oauthHandler: OmniOAuthHandler | undefined;
  let lastError: string | undefined;
  let currentAuthMode: OmniAuthMode = OMNI_DEFAULT_AUTH_MODE;
  let currentToolPermissions: OmniToolPermissions = {};

  const now = deps.now ?? (() => Date.now());
  const newToken = deps.newToken ?? (() => randomBytes(OMNI_GATEWAY_TOKEN_BYTES).toString('hex'));
  const newId = deps.newId ?? (() => `omni-${randomBytes(12).toString('hex')}`);

  const emitProgress = (
    phase: OmniGatewayProgressPhase,
    detail?: { message?: string; tunnelUrl?: string; error?: string }
  ): void => deps.emitProgress?.(phase, detail);

  const disableExternalAccess = (): void => {
    stopOmniTunnel();
    live?.tokenStore.revokeExternalToken();
    live?.tokenStore.revokeAllDebugTokens();
    liveExternal = undefined;
  };

  const stop = async (): Promise<void> => {
    if (liveExternal) {
      try {
        stopOmniTunnel();
      } catch (error) {
        console.warn('[OmniGateway] Error stopping tunnel:', error);
      }
      liveExternal = undefined;
    }
    if (!live) return;
    try {
      await live.host.close();
    } catch (error) {
      console.warn('[OmniGateway] Error while closing host:', error);
    }
    live = undefined;
    oauthHandler = undefined;
  };

  const startExternalAccess = async (): Promise<LiveOmniGatewayExternal> => {
    if (!live) throw new Error('The local MCP gateway is not running.');

    disableExternalAccess();
    emitProgress('minting-token');
    const bearerToken = live.tokenStore.mintExternalToken(OMNI_EXTERNAL_TOKEN_DEFAULT_TTL_MS);
    const tunnel: StartOmniTunnelResult = await startOmniTunnel(live.host.port, {
      onProgress: (phase, message) => emitProgress(phase, message ? { message } : undefined),
    });
    if (!tunnel.ok) {
      live.tokenStore.revokeExternalToken();
      const reason = 'reason' in tunnel ? tunnel.reason : 'start-failed';
      const rawDetail = 'detail' in tunnel ? tunnel.detail : undefined;
      const detail = rawDetail ? ` ${rawDetail}` : '';
      throw new Error(`Could not start secure Web access (${reason}).${detail}`);
    }

    liveExternal = { tunnelUrl: tunnel.url, bearerToken };
    emitProgress('ready', { tunnelUrl: tunnel.url });
    return liveExternal;
  };

  const start = async (cfg: OmniGatewayRuntimeConfig, localBearerToken: string): Promise<void> => {
    if (!cfg.rootPath) {
      throw new Error('No workspace folder configured. Pick one in External MCP Gateway settings.');
    }

    await stop();

    const securityState = await deps.loadSecurityState();
    const sessionTtlMs = securityState.sessionTtlMs;
    currentAuthMode = securityState.authMode;
    currentToolPermissions = securityState.toolPermissions;

    const state = createOmniGatewayState({ now, newId, sessionTtlMs });
    const tokenStore = createOmniGatewayTokenStore({ now, newToken });
    const ideDeps = deps.buildIdeDeps();

    const debugBridge = cfg.externalMode?.enabled
      ? createOmniDebugBridge({
          tokenStore,
          state,
          ide: ideDeps.ide,
          rootPath: cfg.rootPath,
          sessionTtlMs,
          getMcpEndpoint: () => (liveExternal ? `${liveExternal.tunnelUrl}/ide/mcp` : undefined),
        })
      : undefined;

    oauthHandler = cfg.externalMode?.enabled
      ? createOmniOAuthHandler({
          store: deps.oauth(),
          getPublicOrigin: () => liveExternal?.tunnelUrl,
        })
      : undefined;

    const host = await startOmniGatewayHost({
      port: cfg.port,
      localBearerToken,
      isExternalBearerValid: (presented) => tokenStore.isExternalTokenValid(presented),
      getAuthMode: () => currentAuthMode,
      isOAuthTokenValid: async (presented) => (await deps.oauth().validateAccessToken(presented)) !== undefined,
      oauthHandler: oauthHandler ? (req, res) => (oauthHandler as OmniOAuthHandler).tryHandle(req, res) : undefined,
      buildIdeServer: (mode) =>
        buildOmniIdeServer({
          state,
          rootPath: cfg.rootPath as string,
          allowDangerous: cfg.allowDangerous,
          sessionTtlMs,
          ideDeps,
          mode,
          toolPermissions: currentToolPermissions,
        }),
      debugBridge: debugBridge?.handle,
    });

    live = { host, state, tokenStore };
    lastError = undefined;

    if (cfg.externalMode?.enabled) {
      try {
        await startExternalAccess();
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        console.warn('[OmniGateway] Web access start failed:', error);
        emitProgress('failed', { error: lastError });
      }
    }
  };

  return {
    start,
    stop,
    startExternalAccess,
    disableExternalAccess,
    snapshot: () => ({
      live,
      liveExternal,
      lastError,
      authMode: currentAuthMode,
      toolPermissions: currentToolPermissions,
    }),
    setAuthMode: (mode) => {
      currentAuthMode = mode;
    },
    setToolPermissions: (permissions) => {
      currentToolPermissions = permissions;
    },
  };
};
