/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The "IDE" profile of the Omni External MCP Gateway.
 *
 * A *profile* is a small interface — same shape every future profile (music,
 * browser, …) will implement — that knows how to build an {@link McpServer}
 * exposing four `omni_*` housekeeping tools plus a curated set of the
 * underlying app's real tools (here: `ide_*` / `team_*` / `db_*` /
 * `ide_memory_*` re-used from {@link createIdeServer}).
 *
 * The profile is INERT until `buildServer(deps)` is called by the host with a
 * fresh per-connection state machine. That gives us per-connection isolation
 * without per-connection allocation of the underlying services (which are
 * shared singletons).
 *
 * Process boundary: Main-process (Node.js / Electron). No DOM APIs.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createIdeServer, type IdeServerDeps } from '@process/ide/mcp/ideServer';
import type { ToolGuard, ToolGuardResult } from '@process/ide/mcp/ideServerToolGuard';
import { loadProjectRules } from '@process/ide/rulesLoader';
import { buildOmniBootstrapResult } from './omniBootstrap';
import {
  OMNI_IDE_BASE_ALLOWLIST,
  OMNI_IDE_BASE_ALLOWLIST_NAMES,
  OMNI_IDE_DANGEROUS_NAMES,
  OMNI_IDE_DANGEROUS_TOOLS,
} from './omniIdeAllowlist';
import type { OmniGatewayState } from './omniGatewayState';
import type { OmniRequestMode } from './omniGatewayHost';
import type { OmniToolPermissions } from './auth/authTypes';

/** Canonical name advertised in the MCP `initialize` handshake. */
export const OMNI_IDE_SERVER_NAME = 'aionui-omni-ide';

/** Cross-tool guidance returned in the MCP server's `instructions` field. */
export const OMNI_IDE_SERVER_INSTRUCTIONS =
  'This server exposes Tomni Agentic IDE tools. Before calling any ide_/team_/db_ tool, ' +
  'call omni_bootstrap_session (with an EMPTY {} arguments object) to receive the active ' +
  'workspace guide, project rules, session id, and allowed-tool list. Pass the returned ' +
  'sessionId as the `sessionId` argument on every subsequent tool call. Do not send optional ' +
  'fields you do not need (e.g. omit planningEnabled rather than sending false). Do not infer ' +
  'filesystem or terminal behavior — use only the tools this server lists.';

/** Per-connection deps the profile uses to build a server. */
export type OmniIdeProfileDeps = {
  /** Live state machine (shared across connections; sessionId scopes per-host). */
  state: OmniGatewayState;
  /** Workspace root the gateway serves. */
  rootPath: string;
  /** Whether the "dangerous tools" opt-in is currently on. */
  allowDangerous: boolean;
  /** Idle TTL surfaced in bootstrap policy. */
  sessionTtlMs: number;
  /** IDE server deps (already wired with all service singletons). */
  ideDeps: Omit<IdeServerDeps, 'toolGuard'>;
  /**
   * Which auth mode authorised this server's transport. `external` connections
   * are restricted to the tighter {@link OMNI_IDE_EXTERNAL_ALLOWLIST_NAMES}
   * regardless of the user's `allowDangerous` flag.
   */
  mode?: OmniRequestMode;
  /**
   * Per-tool permission overrides. A tool mapped to `true` is explicitly
   * allowed (bypasses the dangerous-tools gate); `false` is explicitly denied
   * (even for a base/safe tool); absent falls back to the default policy.
   */
  toolPermissions?: OmniToolPermissions;
};

/** Build the IDE-profile {@link McpServer} bound to the supplied deps. */
export const buildOmniIdeServer = (deps: OmniIdeProfileDeps): McpServer => {
  // The tool-guard is the only thing that makes the underlying ideServer
  // safe to expose externally: it refuses every tool call until the host has
  // bootstrapped + presented a matching sessionId, and refuses dangerous
  // tools when the opt-in flag is off.
  const toolGuard: ToolGuard = (toolName, args) => evaluateExternalTool(toolName, args, deps);

  const server = createIdeServer({ ...deps.ideDeps, toolGuard }) as McpServer;
  // The McpServer constructor inside createIdeServer omits `instructions`; we
  // can't retrofit a different one onto the same instance, so the host wraps
  // the SDK constructor below and registers the omni_* tools directly on the
  // already-built server (which is supported).
  registerOmniTools(server, deps);
  return server;
};

/** Register the four `omni_*` housekeeping tools onto an existing server. */
const registerOmniTools = (server: McpServer, deps: OmniIdeProfileDeps): void => {
  server.tool(
    'omni_bootstrap_session',
    `Bind this MCP session to the AionUi workspace and receive the active guide, project rules,
session id, and allowed-tool list. CALL THIS FIRST — every other ide_/team_/db_ tool is gated
until you have a sessionId from this call and pass it back as the sessionId argument.

IMPORTANT: call this with an EMPTY arguments object {} (pass NO arguments). Only include the
optional planningEnabled field when you explicitly want Planning Mode AND its value is true;
never send planningEnabled:false — omit it instead. Some hosts (e.g. the ChatGPT connector)
block tool calls that carry unnecessary optional fields, so the empty-payload form is the most
reliable.

The returned activeGuide explains how the workspace expects you to work (Strict IDE Mode,
semantic ide_* tools, team_* writes). Read it before acting.`,
    {
      planningEnabled: z
        .boolean()
        .optional()
        .describe(
          'Optional: set to true ONLY to opt into Planning Mode guidance. Otherwise omit this field entirely — do not send false. Prefer calling with an empty {} arguments object.'
        ),
    },
    async ({ planningEnabled }) => {
      const rules = await loadProjectRules(deps.rootPath).catch(() => [] as string[]);
      const result = buildOmniBootstrapResult({
        rootPath: deps.rootPath,
        rules,
        planningEnabled: planningEnabled === true,
        allowDangerous: deps.allowDangerous,
        baseAllowlist: OMNI_IDE_BASE_ALLOWLIST,
        dangerousTools: OMNI_IDE_DANGEROUS_TOOLS,
        serverInstructions: OMNI_IDE_SERVER_INSTRUCTIONS,
        sessionTtlMs: deps.sessionTtlMs,
        state: deps.state,
      });
      return jsonResult(result);
    }
  );

  server.tool(
    'omni_get_active_guide',
    `Return the workspace primer (Markdown) for an already-bootstrapped session. Useful if the
external client wants to re-read the active guide without re-bootstrapping (the sessionId is
unchanged).`,
    { sessionId: z.string().describe('The sessionId from omni_bootstrap_session.') },
    async ({ sessionId }) => {
      const session = deps.state.getSession(sessionId);
      if (!session) return textErr('Unknown or expired sessionId. Call omni_bootstrap_session again.');
      const rules = await loadProjectRules(session.rootPath).catch(() => [] as string[]);
      const result = buildOmniBootstrapResult({
        rootPath: session.rootPath,
        rules,
        planningEnabled: false,
        allowDangerous: session.allowDangerous,
        baseAllowlist: OMNI_IDE_BASE_ALLOWLIST,
        dangerousTools: OMNI_IDE_DANGEROUS_TOOLS,
        serverInstructions: OMNI_IDE_SERVER_INSTRUCTIONS,
        sessionTtlMs: deps.sessionTtlMs,
        state: deps.state,
      });
      // Replace the freshly-issued sessionId with the caller's existing one so
      // the response is stable for the host.
      return jsonResult({ ...result, sessionId });
    }
  );

  server.tool(
    'omni_get_project_context',
    `Return lightweight project context (rootPath, raw rules array) without rotating the session.`,
    { sessionId: z.string().describe('The sessionId from omni_bootstrap_session.') },
    async ({ sessionId }) => {
      const session = deps.state.getSession(sessionId);
      if (!session) return textErr('Unknown or expired sessionId. Call omni_bootstrap_session again.');
      const rules = await loadProjectRules(session.rootPath).catch(() => [] as string[]);
      return jsonResult({
        rootPath: session.rootPath,
        rules,
        allowDangerous: session.allowDangerous,
        issuedAt: session.issuedAt,
      });
    }
  );

  server.tool(
    'omni_list_tools',
    `List every tool this gateway exposes with its allowance status. Equivalent to the tool list
embedded in omni_bootstrap_session — provided as its own tool so a host can re-check policy
after a settings flip.`,
    {},
    async () => {
      return jsonResult({
        baseAllowlist: OMNI_IDE_BASE_ALLOWLIST,
        dangerousTools: OMNI_IDE_DANGEROUS_TOOLS.map((t) => ({ ...t, allowed: deps.allowDangerous })),
        allowDangerous: deps.allowDangerous,
      });
    }
  );
};

/** Per-call guard: refuses tool calls until bootstrap + allowlist hold. */
const evaluateExternalTool = (toolName: string, args: unknown, deps: OmniIdeProfileDeps): ToolGuardResult => {
  if (toolName.startsWith('omni_')) return { allow: true };

  // Per-tool explicit DENY takes precedence over everything else (even a base
  // tool the user has turned off). Checked before the allowlist so the user
  // can lock down individual tools regardless of group membership.
  const explicit = deps.toolPermissions?.[toolName];
  if (explicit === false) {
    return { allow: false, reason: `Tool "${toolName}" has been disabled for the External MCP Gateway in Settings.` };
  }

  // 1) Tool must be in either the base or dangerous list — everything else is denied.
  const isBase = OMNI_IDE_BASE_ALLOWLIST_NAMES.has(toolName);
  const isDangerous = OMNI_IDE_DANGEROUS_NAMES.has(toolName);
  if (!isBase && !isDangerous) {
    return { allow: false, reason: `Tool "${toolName}" is not exposed by the External MCP Gateway.` };
  }

  // 1b) External (public-tunnel) sessions use the SAME allowlist as local —
  //     this MCP only ever calls the same in-app IDE tools the local agent
  //     uses, and the user explicitly enables Web Access. The only gating
  //     left is the dangerous flag below, identical to the local plane.

  // 2) Caller must pass sessionId as an argument (zod has already validated it
  //    if present; here we treat missing/empty as "not bootstrapped").
  const sessionId =
    args &&
    typeof args === 'object' &&
    'sessionId' in args &&
    typeof (args as { sessionId?: unknown }).sessionId === 'string'
      ? (args as { sessionId: string }).sessionId
      : undefined;
  if (!sessionId) {
    return {
      allow: false,
      reason:
        'Missing sessionId. Call omni_bootstrap_session first and pass the returned sessionId on every tool call.',
    };
  }

  const session = deps.state.getSession(sessionId);
  if (!session) {
    return { allow: false, reason: 'Unknown or expired sessionId. Call omni_bootstrap_session again.' };
  }

  // 3) A per-tool explicit ALLOW bypasses the dangerous-tools gate — the user
  //    has opted this specific tool in. Otherwise dangerous tools still require
  //    the global "Allow dangerous tools" opt-in.
  if (explicit !== true && isDangerous && !session.allowDangerous) {
    return {
      allow: false,
      reason: `Tool "${toolName}" is in the dangerous group. Enable "Allow dangerous tools" in AionUi → Settings → External MCP Gateway, or allow it individually.`,
    };
  }

  deps.state.touch(sessionId);
  return { allow: true };
};

// ---------------------------------------------------------------------------
// Local MCP result helpers (mirror ideServer's textResult)
// ---------------------------------------------------------------------------

type McpTextResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const textErr = (text: string): McpTextResult => ({ content: [{ type: 'text', text }], isError: true });

const jsonResult = (value: unknown): McpTextResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
