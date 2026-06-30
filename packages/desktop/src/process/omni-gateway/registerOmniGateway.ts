/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lifecycle orchestrator for the Omni External MCP Gateway.
 *
 * - Reads `externalMcp.config` from `ProcessConfig` and the bearer token from
 *   the encrypted credential store.
 * - Starts the gateway host when enabled; stops it when disabled; restarts it
 *   when the user changes port / rotates token / flips dangerous flag.
 * - Idempotent — safe to call repeatedly (boot, settings change, manual retry).
 * - Failures are swallowed and logged: a registration problem must NEVER block
 *   app boot, and the internal IDE plane keeps working regardless.
 *
 * Process boundary: Main-process (Node.js / Electron). No DOM APIs.
 */

import { randomBytes } from 'node:crypto';
import { ProcessConfig } from '@process/utils/initStorage';
import { createCredentialStore, type ICredentialStore, type Credential } from '@process/automation/credentialStore';
import { getDbService } from '@process/ide/db/dbWiring';
import { getSessionMemoryStore } from '@process/ide/memory/sessionMemoryStore';
import { getTeamEditService } from '@process/ide/teamEdit/teamEditService';
import { getIdeMcpService, getQuickTestRunner } from '@process/ide/mcp/ideMcpWiring';
import type { DbAgentService } from '@process/ide/mcp/ideServer';
import { OmniGatewayAddressInUseError } from './omniGatewayHost';
import { createOmniGatewayRuntime } from './omniGatewayRuntime';
import { stopOmniTunnel } from './omniGatewayTunnel';
import { createOmniSecurityStore, type IOmniSecurityStore } from './auth/omniGatewaySecurityStore';
import { createOmniOAuthStore, type OmniOAuthStore } from './auth/omniGatewayOAuthStore';
import {
  OMNI_DEFAULT_AUTH_MODE,
  isOmniAuthMode,
  type OmniAuthMode,
  type OmniOAuthClientSummary,
  type OmniToolPermissions,
} from './auth/authTypes';
import { ipcBridge } from '@/common';
import { makeProgressEmitter, type OmniGatewayProgressEvent } from './omniGatewayProgress';
import { normalizePublicBaseUrl, validatePublicBaseUrl, type RemoteAccessMode } from '@/common/config/remotePublicUrl';

/** Config key holding the gateway's user-facing settings (no plaintext token). */
export const OMNI_GATEWAY_CONFIG_KEY = 'externalMcp.config';

/** Credential id used to store the bearer token in the encrypted vault. */
export const OMNI_GATEWAY_CREDENTIAL_ID = 'omni-gateway-token';

/** Default values for the External MCP Gateway. */
export const OMNI_GATEWAY_DEFAULT_PORT = 47821;
export const OMNI_GATEWAY_DEFAULT_SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6h
export const OMNI_GATEWAY_TOKEN_BYTES = 32;

/** Persisted shape of the gateway's user-facing settings. */
export type OmniGatewayConfig = {
  enabled: boolean;
  port: number;
  /** Workspace folder the gateway pins external sessions to. */
  rootPath?: string;
  /** When true, the "dangerous tools" group is exposed (db_*, shell, etc.). */
  allowDangerous: boolean;
  tokenCreatedAt?: number;
  tokenLastRotatedAt?: number;
  /**
   * Web Access — publish the gateway through a Cloudflare Quick Tunnel
   * so ChatGPT/Grok/Claude on the web can reach `/ide/mcp` and `/debug/omni/*`.
   * SSE is intentionally NOT published — Quick Tunnels don't proxy it reliably.
   *
   * This is an explicitly enabled, short-lived access mode. Off by default.
   */
  externalMode?: {
    enabled: boolean;
  };
  /**
   * Remote Access display preferences (Quick vs Setup). These DO NOT manage the
   * tunnel — they only control which public base URL the Settings panel shows
   * and copies. Quick mode reflects the live Quick-Tunnel URL (runtime only);
   * Setup mode persists user-provided stable URLs that survive restarts.
   */
  remote?: {
    /** Selected remote-access mode. Defaults to 'quick' (legacy behavior). */
    mode: RemoteAccessMode;
    /** Stable public base URL for the MCP plane (Setup mode), e.g. a Named Tunnel. */
    stableMcpBaseUrl?: string;
    /** Stable public base URL for the WebUI plane (Setup mode). */
    stableWebuiBaseUrl?: string;
  };
};

/** Public status reported back to the renderer UI. */
export type OmniGatewayStatus = {
  enabled: boolean;
  running: boolean;
  port: number;
  rootPath?: string;
  allowDangerous: boolean;
  /** Loopback SSE URL — local clients only. */
  ideSseUrl?: string;
  /** Loopback Streamable HTTP URL — local + tunnel-safe. */
  ideMcpUrl?: string;
  hasToken: boolean;
  tokenCreatedAt?: number;
  tokenLastRotatedAt?: number;
  /** Public Web Access status. */
  externalMode?: {
    enabled: boolean;
    running: boolean;
    tunnelUrl?: string;
    mcpUrl?: string;
    tokenExpiresAt?: number;
    debugTokenCount: number;
  };
  /** Multi-mode auth state for the Web Access plane. */
  auth?: {
    /** Configured auth mode (bearer | oauth | none | mixed). */
    mode: OmniAuthMode;
    /** Idle session TTL in ms. */
    sessionTtlMs: number;
    /** Per-tool allow/deny overrides (absent tools follow the default policy). */
    toolPermissions: OmniToolPermissions;
    /** Registered OAuth clients (secret-free summaries). */
    oauthClients: OmniOAuthClientSummary[];
    /** OAuth discovery URL (authorization-server metadata), when the tunnel is up. */
    oauthMetadataUrl?: string;
  };
  /**
   * Remote Access snapshot for the Quick/Setup mode UI. `quick*` fields reflect
   * the live Quick Tunnel (empty until it starts); `stable*` fields are the
   * user-saved persistent URLs from Setup mode.
   */
  remote?: {
    mode: RemoteAccessMode;
    quickMcpBaseUrl?: string;
    quickWebuiBaseUrl?: string;
    stableMcpBaseUrl?: string;
    stableWebuiBaseUrl?: string;
  };
  lastError?: string;
};

let lastError: string | undefined;
let credentialStore: ICredentialStore | undefined;
let securityStore: IOmniSecurityStore | undefined;
let oauthStore: OmniOAuthStore | undefined;

/**
 * Live caches of the two auth fields the host reads on EVERY request. They are
 * refreshed from the encrypted store whenever it is loaded or patched so the
 * host's `getAuthMode` / `toolPermissions` closures stay current without a
 * restart and without an async read on the hot path.
 */
let currentAuthMode: OmniAuthMode = OMNI_DEFAULT_AUTH_MODE;
let currentToolPermissions: OmniToolPermissions = {};

// ---------------------------------------------------------------------------
// Security store + OAuth singletons
// ---------------------------------------------------------------------------

const security = (): IOmniSecurityStore => {
  if (!securityStore) securityStore = createOmniSecurityStore();
  return securityStore;
};

const oauth = (): OmniOAuthStore => {
  if (!oauthStore) {
    oauthStore = createOmniOAuthStore({
      security: security(),
      now: () => Date.now(),
      newToken: () => randomBytes(OMNI_GATEWAY_TOKEN_BYTES).toString('hex'),
      newId: () => `oc-${randomBytes(12).toString('hex')}`,
    });
  }
  return oauthStore;
};

// ---------------------------------------------------------------------------
// Web Access progress — broadcast over IPC so the Settings panel can render
// per-phase text instead of an opaque spinner during the slow startup steps
// (cloudflared install ~5–30 s first run, URL assignment ~5–25 s every run).
// ---------------------------------------------------------------------------

/**
 * Last progress event we emitted. Cached so a Settings panel that mounts AFTER
 * a phase has fired (e.g. user opened Settings mid-startup) can still render
 * the current state on first subscribe. Reset to `idle` on every fresh start.
 */
let lastProgress: OmniGatewayProgressEvent | undefined;

const broadcastProgress = (event: OmniGatewayProgressEvent): void => {
  lastProgress = event;
  try {
    ipcBridge.omniGateway.progress.emit(event);
  } catch (error) {
    // Never let an IPC failure crash the lifecycle — log and continue.
    console.warn('[OmniGateway] progress emit failed:', error);
  }
};

const emitProgress = makeProgressEmitter(broadcastProgress, () => Date.now());

/** Renderer-facing read of the latest progress event, for late-mount UIs. */
export const getOmniGatewayLatestProgress = (): OmniGatewayProgressEvent | undefined => lastProgress;

const gatewayRuntime = createOmniGatewayRuntime({
  loadSecurityState: () => security().load(),
  oauth,
  buildIdeDeps: () => ({
    ide: getIdeMcpService(),
    quickTest: getQuickTestRunner(),
    db: getDbService() as DbAgentService,
    memory: getSessionMemoryStore(),
    teamEdit: getTeamEditService(),
  }),
  emitProgress: (phase, detail) =>
    emitProgress(
      phase,
      detail?.message ? { message: detail.message } : detail?.tunnelUrl ? { tunnelUrl: detail.tunnelUrl } : detail
    ),
  now: () => Date.now(),
  newToken: () => randomBytes(OMNI_GATEWAY_TOKEN_BYTES).toString('hex'),
  newId: () => `omni-${randomBytes(12).toString('hex')}`,
});

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

const store = (): ICredentialStore => {
  if (!credentialStore) credentialStore = createCredentialStore();
  return credentialStore;
};

const findGatewayCredential = async (): Promise<Credential | undefined> =>
  store()
    .list()
    .then((list) => list.find((c) => c.id === OMNI_GATEWAY_CREDENTIAL_ID));

const readToken = async (): Promise<string | undefined> => {
  const cred = await findGatewayCredential();
  if (!cred) return undefined;
  const decrypted = await store().getDecrypted(cred.id);
  const value = decrypted?.bearer;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const writeToken = async (token: string): Promise<void> => {
  await store().save({
    id: OMNI_GATEWAY_CREDENTIAL_ID,
    name: 'AionUi External MCP Gateway',
    kind: 'token',
    fields: { bearer: token },
  });
};

const generateToken = (): string => randomBytes(OMNI_GATEWAY_TOKEN_BYTES).toString('hex');

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Coerce the persisted `remote` block defensively (loosely-typed storage). */
const parseRemoteConfig = (raw: unknown): OmniGatewayConfig['remote'] => {
  if (!raw || typeof raw !== 'object') return { mode: 'quick' };
  const r = raw as Partial<NonNullable<OmniGatewayConfig['remote']>>;
  const mode: RemoteAccessMode = r.mode === 'setup' ? 'setup' : 'quick';
  const stableMcpBaseUrl =
    typeof r.stableMcpBaseUrl === 'string' && r.stableMcpBaseUrl.length > 0 ? r.stableMcpBaseUrl : undefined;
  const stableWebuiBaseUrl =
    typeof r.stableWebuiBaseUrl === 'string' && r.stableWebuiBaseUrl.length > 0 ? r.stableWebuiBaseUrl : undefined;
  return { mode, stableMcpBaseUrl, stableWebuiBaseUrl };
};

const readConfig = async (): Promise<OmniGatewayConfig> => {
  // ProcessConfig is loosely typed for unregistered keys; coerce defensively.
  const raw = (await ProcessConfig.get(OMNI_GATEWAY_CONFIG_KEY as never)) as unknown;
  const cfg = (raw && typeof raw === 'object' ? (raw as Partial<OmniGatewayConfig>) : {}) as Partial<OmniGatewayConfig>;
  return {
    enabled: cfg.enabled === true,
    port: typeof cfg.port === 'number' && cfg.port >= 1024 && cfg.port <= 65535 ? cfg.port : OMNI_GATEWAY_DEFAULT_PORT,
    rootPath: typeof cfg.rootPath === 'string' && cfg.rootPath.length > 0 ? cfg.rootPath : undefined,
    allowDangerous: cfg.allowDangerous === true,
    tokenCreatedAt: typeof cfg.tokenCreatedAt === 'number' ? cfg.tokenCreatedAt : undefined,
    tokenLastRotatedAt: typeof cfg.tokenLastRotatedAt === 'number' ? cfg.tokenLastRotatedAt : undefined,
    externalMode:
      cfg.externalMode && typeof cfg.externalMode === 'object'
        ? { enabled: cfg.externalMode.enabled === true }
        : undefined,
    remote: parseRemoteConfig(cfg.remote),
  };
};

const writeConfig = async (cfg: OmniGatewayConfig): Promise<void> => {
  await ProcessConfig.set(OMNI_GATEWAY_CONFIG_KEY as never, cfg as never);
};

// ---------------------------------------------------------------------------
// Lifecycle (start / stop / restart)
// ---------------------------------------------------------------------------

const stopHost = async (): Promise<void> => {
  await gatewayRuntime.stop();
};

const disableExternalAccessRuntime = (): void => {
  gatewayRuntime.disableExternalAccess();
};

const startExternalAccessRuntime = async () => gatewayRuntime.startExternalAccess();

const startHost = async (cfg: OmniGatewayConfig, token: string): Promise<void> => {
  await gatewayRuntime.start(cfg, token);
  lastError = gatewayRuntime.snapshot().lastError;
};

/**
 * Start the gateway if enabled in settings, otherwise no-op. Called at boot
 * and after every settings change. Idempotent: existing host is closed first.
 */
export const ensureOmniGatewayStarted = async (): Promise<boolean> => {
  try {
    const cfg = await readConfig();
    await stopHost();

    if (!cfg.enabled) return true;

    // Auto-mint a token the first time the user enables the gateway, so the
    // Settings panel can show one immediately rather than asking the user to
    // press "Regenerate" before anything works.
    let token = await readToken();
    if (!token) {
      token = generateToken();
      await writeToken(token);
      cfg.tokenCreatedAt = Date.now();
      await writeConfig(cfg);
    }

    await startHost(cfg, token);
    return true;
  } catch (error) {
    if (error instanceof OmniGatewayAddressInUseError) {
      lastError = `Port ${error.port} is already in use. Pick a different port in External MCP Gateway settings.`;
    } else if (error instanceof Error) {
      lastError = error.message;
    } else {
      lastError = String(error);
    }
    console.warn('[OmniGateway] Could not start gateway:', lastError);
    return false;
  }
};

/** Read the gateway's live status for the Settings UI. */
export const getOmniGatewayStatus = async (): Promise<OmniGatewayStatus> => {
  const cfg = await readConfig();
  const token = await readToken();
  const securityState = await security().load();
  const oauthClients = await oauth().listClients();
  const runtime = gatewayRuntime.snapshot();
  const live = runtime.live;
  const liveExternal = runtime.liveExternal;
  return {
    enabled: cfg.enabled,
    running: live !== undefined,
    port: cfg.port,
    rootPath: cfg.rootPath,
    allowDangerous: cfg.allowDangerous,
    ideSseUrl: live?.host.ideSseUrl,
    ideMcpUrl: live?.host.ideMcpUrl,
    hasToken: token !== undefined,
    tokenCreatedAt: cfg.tokenCreatedAt,
    tokenLastRotatedAt: cfg.tokenLastRotatedAt,
    externalMode: {
      enabled: cfg.externalMode?.enabled === true,
      running: liveExternal !== undefined && liveExternal.bearerToken.expiresAt > Date.now(),
      tunnelUrl: liveExternal?.tunnelUrl,
      mcpUrl: liveExternal ? `${liveExternal.tunnelUrl}/ide/mcp` : undefined,
      tokenExpiresAt: liveExternal?.bearerToken.expiresAt,
      debugTokenCount: live?.tokenStore.listDebugTokens().length ?? 0,
    },
    auth: {
      mode: securityState.authMode,
      sessionTtlMs: securityState.sessionTtlMs,
      toolPermissions: securityState.toolPermissions,
      oauthClients,
      oauthMetadataUrl: liveExternal ? `${liveExternal.tunnelUrl}/.well-known/oauth-authorization-server` : undefined,
    },
    remote: {
      mode: cfg.remote?.mode ?? 'quick',
      // Quick URLs reflect the live tunnel — empty until/unless it is running.
      quickMcpBaseUrl: liveExternal?.tunnelUrl,
      quickWebuiBaseUrl: liveExternal?.tunnelUrl,
      stableMcpBaseUrl: cfg.remote?.stableMcpBaseUrl,
      stableWebuiBaseUrl: cfg.remote?.stableWebuiBaseUrl,
    },
    lastError,
  };
};

/** Apply a partial config patch from the Settings UI; restarts if needed. */
export const applyOmniGatewayConfig = async (patch: Partial<OmniGatewayConfig>): Promise<OmniGatewayStatus> => {
  const cfg = await readConfig();
  const next: OmniGatewayConfig = {
    ...cfg,
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cfg.enabled,
    port: typeof patch.port === 'number' && patch.port >= 1024 && patch.port <= 65535 ? patch.port : cfg.port,
    rootPath: typeof patch.rootPath === 'string' && patch.rootPath.length > 0 ? patch.rootPath : cfg.rootPath,
    allowDangerous: typeof patch.allowDangerous === 'boolean' ? patch.allowDangerous : cfg.allowDangerous,
  };
  await writeConfig(next);
  await ensureOmniGatewayStarted();
  return getOmniGatewayStatus();
};

/** Rotate the bearer token and restart the host so the new token takes effect. */
export const rotateOmniGatewayToken = async (): Promise<{ token: string; status: OmniGatewayStatus }> => {
  const token = generateToken();
  await writeToken(token);
  const cfg = await readConfig();
  cfg.tokenLastRotatedAt = Date.now();
  if (!cfg.tokenCreatedAt) cfg.tokenCreatedAt = cfg.tokenLastRotatedAt;
  await writeConfig(cfg);
  await ensureOmniGatewayStarted();
  return { token, status: await getOmniGatewayStatus() };
};

/** Reveal the current bearer token to the renderer (Settings UI button). */
export const revealOmniGatewayToken = async (): Promise<string | undefined> => readToken();

/** Enable or rotate the short-lived public Web MCP session. */
export const enableOmniGatewayWebAccess = async (): Promise<{
  token?: string;
  status: OmniGatewayStatus;
}> => {
  const cfg = await readConfig();
  cfg.enabled = true;
  cfg.externalMode = { enabled: true };
  await writeConfig(cfg);
  const started = await ensureOmniGatewayStarted();
  const status = await getOmniGatewayStatus();
  return {
    token: started ? gatewayRuntime.snapshot().liveExternal?.bearerToken.token : undefined,
    status,
  };
};

/** Revoke every public token and stop publishing the gateway. */
export const disableOmniGatewayWebAccess = async (): Promise<OmniGatewayStatus> => {
  emitProgress('stopping');
  const cfg = await readConfig();
  cfg.externalMode = { enabled: false };
  await writeConfig(cfg);
  disableExternalAccessRuntime();
  lastError = undefined;
  emitProgress('stopped');
  return getOmniGatewayStatus();
};

/** Mint a bounded read-only URL token for Web AIs without an MCP connector. */
export const createOmniGatewayDebugAccess = async (): Promise<{
  token: string;
  expiresAt: number;
  healthUrl: string;
  bootstrapUrl: string;
  status: OmniGatewayStatus;
}> => {
  const runtime = gatewayRuntime.snapshot();
  const live = runtime.live;
  const liveExternal = runtime.liveExternal;
  if (!live || !liveExternal) {
    throw new Error('Enable Web access before creating a read-only browser link.');
  }
  const token = live.tokenStore.mintDebugToken();
  const base = `${liveExternal.tunnelUrl}/debug/omni`;
  const queryToken = encodeURIComponent(token.token);
  return {
    token: token.token,
    expiresAt: token.expiresAt,
    healthUrl: `${base}/health?token=${queryToken}`,
    bootstrapUrl: `${base}/bootstrap?token=${queryToken}`,
    status: await getOmniGatewayStatus(),
  };
};

/** Revoke all read-only browser links without interrupting MCP connectors. */
export const revokeOmniGatewayDebugAccess = async (): Promise<OmniGatewayStatus> => {
  gatewayRuntime.snapshot().live?.tokenStore.revokeAllDebugTokens();
  return getOmniGatewayStatus();
};

/**
 * Patch the Remote Access display preferences (Quick vs Setup mode and the
 * user-provided stable URLs). This is a DISPLAY-ONLY change: it never starts,
 * stops, or rotates the Quick Tunnel — it only persists which public base URL
 * the Settings panel shows and copies. Setup-mode URLs are validated and
 * normalized here; an invalid URL is rejected with a clear error so the renderer
 * never silently stores garbage. Quick-mode behavior is left untouched.
 */
export const setOmniGatewayRemoteAccess = async (patch: {
  mode?: RemoteAccessMode;
  stableMcpBaseUrl?: string | null;
  stableWebuiBaseUrl?: string | null;
}): Promise<OmniGatewayStatus> => {
  const cfg = await readConfig();
  const current = cfg.remote ?? { mode: 'quick' };

  const normalizeStable = (value: string | null | undefined, label: string): string | undefined => {
    if (value === null) return undefined; // explicit clear
    if (value === undefined) return undefined; // leave as-is handled by caller below
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    const result = validatePublicBaseUrl(trimmed);
    if (result.normalized === null) {
      throw new Error(`Invalid ${label}: ${result.codes.join(', ')}`);
    }
    return normalizePublicBaseUrl(result.normalized);
  };

  const next: NonNullable<OmniGatewayConfig['remote']> = {
    mode: patch.mode ?? current.mode,
    stableMcpBaseUrl:
      patch.stableMcpBaseUrl === undefined
        ? current.stableMcpBaseUrl
        : normalizeStable(patch.stableMcpBaseUrl, 'Stable MCP Base URL'),
    stableWebuiBaseUrl:
      patch.stableWebuiBaseUrl === undefined
        ? current.stableWebuiBaseUrl
        : normalizeStable(patch.stableWebuiBaseUrl, 'Stable WebUI Base URL'),
  };

  cfg.remote = next;
  await writeConfig(cfg);
  return getOmniGatewayStatus();
};

// ---------------------------------------------------------------------------
// Multi-mode auth controls (Settings UI)
// ---------------------------------------------------------------------------

/**
 * Set the Web Access auth mode. Persisted encrypted and applied LIVE — the host
 * reads `currentAuthMode` on every request, so no restart is needed.
 */
export const setOmniGatewayAuthMode = async (mode: OmniAuthMode): Promise<OmniGatewayStatus> => {
  const safeMode = isOmniAuthMode(mode) ? mode : OMNI_DEFAULT_AUTH_MODE;
  await security().patch({ authMode: safeMode });
  currentAuthMode = safeMode;
  gatewayRuntime.setAuthMode(safeMode);
  return getOmniGatewayStatus();
};

/**
 * Set the idle session TTL (ms). Clamped to a sane range. Takes effect on the
 * NEXT host start (existing sessions keep the TTL they were issued under), so
 * we restart the host to apply it immediately when the gateway is running.
 */
export const setOmniGatewaySessionTtl = async (ttlMs: number): Promise<OmniGatewayStatus> => {
  const MIN_TTL = 60 * 1000; // 1 min
  const MAX_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
  const clamped = Math.min(Math.max(Math.floor(ttlMs), MIN_TTL), MAX_TTL);
  await security().patch({ sessionTtlMs: clamped });
  if (gatewayRuntime.snapshot().live) await ensureOmniGatewayStarted();
  return getOmniGatewayStatus();
};

/**
 * Set (or clear) a per-tool permission override. `allowed === null` removes the
 * override so the tool falls back to the default policy. Applied live.
 */
export const setOmniGatewayToolPermission = async (
  toolName: string,
  allowed: boolean | null
): Promise<OmniGatewayStatus> => {
  const state = await security().load();
  const next: OmniToolPermissions = { ...state.toolPermissions };
  if (allowed === null) delete next[toolName];
  else next[toolName] = allowed;
  await security().patch({ toolPermissions: next });
  currentToolPermissions = next;
  gatewayRuntime.setToolPermissions(next);
  return getOmniGatewayStatus();
};

/** List registered OAuth clients (secret-free) for the Settings UI. */
export const listOmniGatewayOAuthClients = async (): Promise<OmniOAuthClientSummary[]> => oauth().listClients();

/** Revoke an OAuth client and all of its tokens. Applied live. */
export const revokeOmniGatewayOAuthClient = async (clientId: string): Promise<OmniGatewayStatus> => {
  await oauth().revokeClient(clientId);
  return getOmniGatewayStatus();
};
