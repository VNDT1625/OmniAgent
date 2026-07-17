/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared, pure types for the Omni External MCP Gateway's multi-mode auth layer.
 *
 * A Web Access session can be authorised in one of four modes:
 *  - `oauth`  — OAuth 2.1 + PKCE (works with the ChatGPT MCP connector and any
 *               RFC 9728 / RFC 8414 capable client).
 *  - `bearer` — the long-standing short-TTL Bearer token (unchanged behaviour).
 *  - `none`   — legacy persisted value; runtime hardens it to short-TTL Bearer auth.
 *  - `mixed`  — accept EITHER a valid OAuth access token OR the Bearer token.
 *
 * Per-tool permissions let the user allow/deny individual gateway tools
 * regardless of the coarse "dangerous tools" flag.
 *
 * This module is pure data + type guards — no Electron, no DOM, no Node fs —
 * so it can be imported from the Main process, the renderer DTO layer, and
 * unit tests alike.
 *
 * Process boundary: shared (pure types).
 */

/** The four authentication modes a Web Access session can run under. */
export type OmniAuthMode = 'oauth' | 'bearer' | 'none' | 'mixed';

/** Every supported auth mode, in UI display order. */
export const OMNI_AUTH_MODES: readonly OmniAuthMode[] = ['bearer', 'oauth', 'mixed', 'none'];

/** Default auth mode — preserves the historical Bearer-only behaviour. */
export const OMNI_DEFAULT_AUTH_MODE: OmniAuthMode = 'bearer';

/** Narrow an arbitrary value to a valid {@link OmniAuthMode}. */
export const isOmniAuthMode = (value: unknown): value is OmniAuthMode =>
  typeof value === 'string' && (OMNI_AUTH_MODES as readonly string[]).includes(value);

/**
 * A per-tool permission override. When a tool name maps to:
 *  - `true`  → explicitly allowed (bypasses the dangerous-tools gate).
 *  - `false` → explicitly denied (even if it is a base/safe tool).
 *  - absent  → fall back to the default policy (base allowed; dangerous gated
 *              behind the `allowDangerous` flag).
 */
export type OmniToolPermissions = Record<string, boolean>;

/**
 * A registered OAuth client (RFC 7591 Dynamic Client Registration result).
 * Public clients (PKCE, no secret) are the norm for MCP connectors; we still
 * support an optional confidential `clientSecret` for completeness.
 */
export type OmniOAuthClient = {
  /** Server-issued opaque client identifier. */
  clientId: string;
  /** Optional client secret for confidential clients (stored encrypted at rest). */
  clientSecret?: string;
  /** Human-readable name supplied at registration (display only). */
  clientName?: string;
  /** Redirect URIs the client may use on /authorize. */
  redirectUris: string[];
  /** Wall-clock ms when the client registered. */
  createdAt: number;
  /** Grant types the client declared (we only honour authorization_code + refresh_token). */
  grantTypes: string[];
  /** Token endpoint auth method (`none` for public PKCE clients). */
  tokenEndpointAuthMethod: string;
};

/** A persisted OAuth access/refresh token pair bound to a client. */
export type OmniOAuthToken = {
  /** Opaque access token presented as `Authorization: Bearer`. */
  accessToken: string;
  /** Opaque refresh token (single active per access token). */
  refreshToken: string;
  /** The client this token was issued to. */
  clientId: string;
  /** Granted scopes (space-delimited canonical list, may be empty). */
  scope: string;
  /** Wall-clock ms when issued. */
  issuedAt: number;
  /** Wall-clock ms after which the access token MUST NOT be accepted. */
  accessExpiresAt: number;
  /** Wall-clock ms after which the refresh token MUST NOT be accepted. */
  refreshExpiresAt: number;
};

/** A public, secret-free view of an OAuth client for the Settings UI. */
export type OmniOAuthClientSummary = {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: number;
  /** Number of currently-live (non-expired) tokens issued to this client. */
  activeTokenCount: number;
};
