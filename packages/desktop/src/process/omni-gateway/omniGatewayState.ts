/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-RAM session state machine for the Omni External MCP Gateway.
 *
 * A session is *issued* when an external host calls `omni_bootstrap_session`
 * and is identified by an opaque `sessionId` string the host must echo back on
 * every subsequent tool call. State never touches disk — it dies with the
 * gateway host process — and never crosses transport boundaries, so reconnects
 * keep the same logical session as long as the `sessionId` is reused.
 *
 * Pure, dependency-injected (`now`, `newId`) so it can be unit-tested without
 * timers or `crypto`.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

/** A single bootstrapped session. */
export type OmniSession = {
  /** Opaque id returned by `omni_bootstrap_session` and echoed by tool calls. */
  sessionId: string;
  /** Workspace root the session is pinned to. */
  rootPath: string;
  /** Wall-clock ms when the session was first issued. */
  issuedAt: number;
  /** Wall-clock ms of the last accepted tool call (for idle TTL). */
  lastSeenAt: number;
  /** Whether the user has opted in to the "dangerous" allowlist this session. */
  allowDangerous: boolean;
};

/** Snapshot record (for `snapshot()` / introspection). */
export type OmniSessionSnapshot = {
  sessionId: string;
  rootPath: string;
  issuedAt: number;
  lastSeenAt: number;
  allowDangerous: boolean;
};

/** Injected dependencies for {@link createOmniGatewayState}. */
export type OmniGatewayStateDeps = {
  /** Wall-clock provider (ms). Tests inject a deterministic counter. */
  now: () => number;
  /** Fresh session-id generator. Tests inject a sequential stub. */
  newId: () => string;
  /** Idle TTL (ms) — sessions whose `lastSeenAt` is older are dropped. */
  sessionTtlMs: number;
};

/** Public API returned by {@link createOmniGatewayState}. */
export type OmniGatewayState = {
  /** Issue a new session bound to `rootPath` + `allowDangerous`. */
  issueSession: (input: { rootPath: string; allowDangerous: boolean }) => OmniSession;
  /** Get a live session by id, or undefined when unknown / expired. */
  getSession: (sessionId: string) => OmniSession | undefined;
  /** Mark `lastSeenAt = now()` for a known session (no-op when unknown). */
  touch: (sessionId: string) => void;
  /** Drop sessions idle longer than `sessionTtlMs`. */
  expireIdle: () => void;
  /** Snapshot of all live sessions (no PII). */
  snapshot: () => OmniSessionSnapshot[];
  /** Drop every session (used by `rotateToken` / `setEnabled(false)`). */
  clear: () => void;
};

/** Build the state machine with the injected clock + id generator. */
export const createOmniGatewayState = (deps: OmniGatewayStateDeps): OmniGatewayState => {
  const sessions = new Map<string, OmniSession>();

  const dropExpired = (): void => {
    const cutoff = deps.now() - deps.sessionTtlMs;
    for (const [id, session] of sessions) {
      if (session.lastSeenAt < cutoff) sessions.delete(id);
    }
  };

  return {
    issueSession: ({ rootPath, allowDangerous }) => {
      dropExpired();
      const now = deps.now();
      const session: OmniSession = {
        sessionId: deps.newId(),
        rootPath,
        issuedAt: now,
        lastSeenAt: now,
        allowDangerous,
      };
      sessions.set(session.sessionId, session);
      return session;
    },
    getSession: (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) return undefined;
      if (deps.now() - session.lastSeenAt > deps.sessionTtlMs) {
        sessions.delete(sessionId);
        return undefined;
      }
      return session;
    },
    touch: (sessionId) => {
      const session = sessions.get(sessionId);
      if (session) session.lastSeenAt = deps.now();
    },
    expireIdle: dropExpired,
    snapshot: () =>
      Array.from(sessions.values()).map((s) => ({
        sessionId: s.sessionId,
        rootPath: s.rootPath,
        issuedAt: s.issuedAt,
        lastSeenAt: s.lastSeenAt,
        allowDangerous: s.allowDangerous,
      })),
    clear: () => sessions.clear(),
  };
};
