/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers for the External Remote Access feature (Quick vs Setup modes).
 *
 * The External MCP Gateway can be reached from the public internet in two ways:
 *
 *  - **Quick mode** — the app spins up a Cloudflare Quick Tunnel and gets a
 *    throwaway `https://<random>.trycloudflare.com` URL. Convenient for a quick
 *    test, but the URL changes on every restart, so it is a poor fit for a
 *    persisted ChatGPT/Grok MCP connector.
 *  - **Setup mode** — the user points their OWN stable public URL (a Cloudflare
 *    Named Tunnel, a VPS reverse proxy, Tailscale Funnel, an ngrok custom
 *    domain, …) at the local services and types that URL in. The app never
 *    manages a tunnel in this mode; it only stores the URL and uses it to
 *    generate copyable endpoints.
 *
 * These helpers are deliberately provider-agnostic and side-effect free so they
 * can be unit-tested without a tunnel, electron, or the network. They are
 * shared by both the Main process (status/endpoint generation) and the renderer
 * (input validation), so they must NOT import anything process-specific.
 */

/** Which remote-access mode the user has selected. */
export type RemoteAccessMode = 'quick' | 'setup';

/** Severity of a {@link validatePublicBaseUrl} finding. */
export type RemoteUrlValidationLevel = 'ok' | 'warning' | 'error';

/** Result of validating a single user-supplied public base URL. */
export type RemoteUrlValidationResult = {
  /** Overall verdict. `warning` still means the URL is usable. */
  level: RemoteUrlValidationLevel;
  /** Normalized URL when {@link level} is `ok` or `warning`; otherwise null. */
  normalized: string | null;
  /**
   * Machine-readable reason codes. Renderers map these to i18n strings rather
   * than displaying raw English — this module stays i18n-agnostic.
   */
  codes: RemoteUrlValidationCode[];
};

/** Stable reason codes a renderer maps to localized copy. */
export type RemoteUrlValidationCode =
  | 'empty'
  | 'missing-protocol'
  | 'invalid-url'
  | 'unsupported-protocol'
  | 'path-not-allowed'
  | 'insecure-public-http'
  | 'temporary-quick-tunnel';

/** Hosts that are allowed to use plain `http://` (local development only). */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Trim whitespace and strip any trailing slashes from a candidate base URL.
 * Pure string hygiene — does NOT validate the result.
 *
 * @example normalizePublicBaseUrl('  https://mcp.example.online/ ') === 'https://mcp.example.online'
 */
export const normalizePublicBaseUrl = (input: string): string => (input ?? '').trim().replace(/\/+$/, '');

/** True when the host part is a loopback / localhost address. */
const isLocalHost = (hostname: string): boolean => LOCAL_HOSTS.has(hostname.toLowerCase());

/** True when the URL host looks like a Cloudflare Quick Tunnel hostname. */
export const isTemporaryQuickTunnelUrl = (input: string): boolean =>
  /(^|\/\/|\.)trycloudflare\.com(\/|$|:)/i.test(input ?? '');

/**
 * Validate a user-supplied public base URL for Setup mode.
 *
 * Rules:
 *  - empty                         → error `empty`
 *  - no `://` protocol             → error `missing-protocol`
 *  - unparseable                   → error `invalid-url`
 *  - protocol other than http/https→ error `unsupported-protocol`
 *  - has a path / query / fragment → error `path-not-allowed` (gateway serves
 *    its routes at the origin root; a base path would break `/ide/mcp` etc.)
 *  - plain http on a non-local host→ warning `insecure-public-http`
 *  - *.trycloudflare.com           → warning `temporary-quick-tunnel`
 *  - http on localhost/127.0.0.1   → ok (local/dev)
 *  - https://host                  → ok
 *
 * Warnings still return a `normalized` URL so the caller can save it; errors
 * return `normalized: null`.
 */
export const validatePublicBaseUrl = (input: string): RemoteUrlValidationResult => {
  const trimmed = (input ?? '').trim();
  if (trimmed.length === 0) {
    return { level: 'error', normalized: null, codes: ['empty'] };
  }
  // A bare host like `mcp.example.online` is rejected: we require an explicit
  // protocol so we never guess http vs https for a public endpoint.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return { level: 'error', normalized: null, codes: ['missing-protocol'] };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { level: 'error', normalized: null, codes: ['invalid-url'] };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { level: 'error', normalized: null, codes: ['unsupported-protocol'] };
  }

  // The gateway mounts `/ide/mcp`, `/debug/omni/*`, etc. at the origin root, so
  // a base URL carrying its own path/query/fragment would produce broken
  // endpoints. Reject with a clear, dedicated code.
  const hasPath = url.pathname !== '' && url.pathname !== '/';
  if (hasPath || url.search !== '' || url.hash !== '') {
    return { level: 'error', normalized: null, codes: ['path-not-allowed'] };
  }

  const normalized = normalizePublicBaseUrl(trimmed);
  const codes: RemoteUrlValidationCode[] = [];

  // Plain http to a public host is allowed but flagged — auth/tokens would
  // travel in clear text. Loopback http is fine for local/dev.
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    codes.push('insecure-public-http');
  }
  if (isTemporaryQuickTunnelUrl(normalized)) {
    codes.push('temporary-quick-tunnel');
  }

  return {
    level: codes.length > 0 ? 'warning' : 'ok',
    normalized,
    codes,
  };
};

/**
 * Join a normalized base URL with a path segment, collapsing the slash seam so
 * neither a trailing slash on the base nor a leading slash on the path produces
 * a doubled `//`. Query strings on `path` are preserved.
 *
 * @example joinRemotePath('https://mcp.example.online', '/ide/mcp') === 'https://mcp.example.online/ide/mcp'
 * @example joinRemotePath('https://mcp.example.online/', 'ide/mcp')  === 'https://mcp.example.online/ide/mcp'
 */
export const joinRemotePath = (baseUrl: string, path: string): string => {
  const base = normalizePublicBaseUrl(baseUrl);
  const suffix = (path ?? '').replace(/^\/+/, '');
  if (suffix.length === 0) return base;
  return `${base}/${suffix}`;
};

/** Input to {@link resolveRemoteEndpoints}. */
export type ResolveRemoteEndpointsInput = {
  mode: RemoteAccessMode;
  /** Runtime Quick-Tunnel base URL (e.g. from the live tunnel). */
  quickBaseUrl?: string | null;
  /** User-saved stable base URL for the MCP plane (Setup mode). */
  stableBaseUrl?: string | null;
  /** Optional debug token to embed in the debug URLs' query string. */
  debugToken?: string | null;
};

/** Generated, copyable endpoints for the selected mode. */
export type ResolvedRemoteEndpoints = {
  /** Base URL actually in effect for the selected mode, or null when missing. */
  effectiveBaseUrl: string | null;
  /** `<base>/ide/mcp` — the Streamable HTTP MCP endpoint. */
  mcpEndpoint: string | null;
  /** `<base>/debug/omni/health[?token=…]`. */
  debugHealthUrl: string | null;
  /** `<base>/debug/omni/bootstrap[?token=…]`. */
  debugBootstrapUrl: string | null;
  /** WebUI base URL (Quick: same tunnel; Setup: separate stable WebUI URL). */
  webuiUrl: string | null;
  /** True when the effective base URL is a throwaway Quick-Tunnel URL. */
  isTemporary: boolean;
  /** Machine-readable advisories (mapped to i18n by the renderer). */
  warnings: RemoteAccessWarningCode[];
};

/** Advisory codes surfaced by {@link resolveRemoteEndpoints}. */
export type RemoteAccessWarningCode =
  | 'temporary-quick-tunnel'
  | 'setup-url-missing'
  | 'setup-url-invalid'
  | 'insecure-public-http';

/** The MCP route the gateway serves (Streamable HTTP). */
export const REMOTE_MCP_PATH = '/ide/mcp';
/** The read-only debug bridge route prefix. */
export const REMOTE_DEBUG_PREFIX = '/debug/omni';

const withDebugToken = (url: string, debugToken?: string | null): string =>
  debugToken ? `${url}?token=${encodeURIComponent(debugToken)}` : url;

/**
 * Resolve the effective base URL and all derived endpoints for the selected
 * remote-access mode. Centralizes the string composition so React components
 * never hand-concatenate URLs.
 *
 * In Setup mode a missing or invalid stable URL does NOT silently fall back to
 * the Quick tunnel: `effectiveBaseUrl` is null and a warning code explains the
 * configuration gap, so the UI can prompt the user to fix it.
 */
export const resolveRemoteEndpoints = (input: ResolveRemoteEndpointsInput): ResolvedRemoteEndpoints => {
  const warnings: RemoteAccessWarningCode[] = [];
  let effectiveBaseUrl: string | null = null;
  let isTemporary = false;

  if (input.mode === 'quick') {
    const quick = input.quickBaseUrl ? normalizePublicBaseUrl(input.quickBaseUrl) : '';
    if (quick.length > 0) {
      effectiveBaseUrl = quick;
      isTemporary = true;
      warnings.push('temporary-quick-tunnel');
    }
  } else {
    const raw = (input.stableBaseUrl ?? '').trim();
    if (raw.length === 0) {
      warnings.push('setup-url-missing');
    } else {
      const validation = validatePublicBaseUrl(raw);
      if (validation.normalized === null) {
        warnings.push('setup-url-invalid');
      } else {
        effectiveBaseUrl = validation.normalized;
        isTemporary = validation.codes.includes('temporary-quick-tunnel');
        if (validation.codes.includes('temporary-quick-tunnel')) warnings.push('temporary-quick-tunnel');
        if (validation.codes.includes('insecure-public-http')) warnings.push('insecure-public-http');
      }
    }
  }

  if (!effectiveBaseUrl) {
    return {
      effectiveBaseUrl: null,
      mcpEndpoint: null,
      debugHealthUrl: null,
      debugBootstrapUrl: null,
      webuiUrl: null,
      isTemporary,
      warnings,
    };
  }

  const debugBase = joinRemotePath(effectiveBaseUrl, REMOTE_DEBUG_PREFIX);
  return {
    effectiveBaseUrl,
    mcpEndpoint: joinRemotePath(effectiveBaseUrl, REMOTE_MCP_PATH),
    debugHealthUrl: withDebugToken(`${debugBase}/health`, input.debugToken),
    debugBootstrapUrl: withDebugToken(`${debugBase}/bootstrap`, input.debugToken),
    // In Quick mode the WebUI and MCP share one tunnel origin. Setup mode uses a
    // distinct stable WebUI base URL resolved separately by the caller.
    webuiUrl: effectiveBaseUrl,
    isTemporary,
    warnings,
  };
};
