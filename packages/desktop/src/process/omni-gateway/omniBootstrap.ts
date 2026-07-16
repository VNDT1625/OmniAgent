/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `omni_bootstrap_session` payload builder.
 *
 * Composes the bootstrap response an external MCP host receives the first time
 * it connects to the gateway: a fresh `sessionId`, the workspace primer
 * (markdown), the raw project rules, the allowed-tool list (annotated with
 * `dangerous` and `allowed` flags), and the standing policy a well-behaved
 * external client should respect.
 *
 * Pure: takes pre-loaded inputs (rules, state) so it can be tested without
 * touching `fs`.
 *
 * Process boundary: Main-process module (no DOM APIs).
 */

import * as path from 'node:path';
import { buildWorkspacePrimer } from '@process/ide/workspacePrimer';
import type { OmniGatewayState } from './omniGatewayState';

/** One tool advertised by the gateway after bootstrap. */
export type OmniBootstrapTool = {
  name: string;
  description: string;
  dangerous: boolean;
  /** False when `dangerous` and `allowDangerous` is off — host should not call. */
  allowed: boolean;
};

/** Policy block returned in every bootstrap response. */
export type OmniBootstrapPolicy = {
  mustCallBootstrapFirst: true;
  sessionTtlMs: number;
  allowDangerous: boolean;
  /** Native tool names the external host should NOT try (Strict IDE Mode mirrors). */
  deniedNativeTools: readonly string[];
};

/** The full `omni_bootstrap_session` result. */
export type OmniBootstrapResult = {
  sessionId: string;
  workspace: { rootPath: string; name: string; detectedAt: number };
  activeGuide: string;
  rules: readonly string[];
  tools: readonly OmniBootstrapTool[];
  policy: OmniBootstrapPolicy;
  serverInstructions: string;
};

/** Inputs for {@link buildOmniBootstrapResult}. Tests pass plain values. */
export type OmniBootstrapInput = {
  rootPath: string;
  rules: readonly string[];
  planningEnabled: boolean;
  allowDangerous: boolean;
  baseAllowlist: readonly { name: string; description: string }[];
  dangerousTools: readonly { name: string; description: string }[];
  serverInstructions: string;
  sessionTtlMs: number;
  state: OmniGatewayState;
};

/** Native tools the external host should never reach for (Strict IDE Mode mirror). */
export const OMNI_DENIED_NATIVE_TOOLS: readonly string[] = [
  'Bash',
  'Read',
  'Grep',
  'Glob',
  'Write',
  'Edit',
  'cat',
  'find',
  'sed',
  'rg',
];

/**
 * Build a complete `omni_bootstrap_session` response. Issues a fresh session in
 * the supplied state machine and returns the response shape the gateway tool
 * sends back to the external host.
 */
export const buildOmniBootstrapResult = (input: OmniBootstrapInput): OmniBootstrapResult => {
  const session = input.state.issueSession({
    rootPath: input.rootPath,
    allowDangerous: input.allowDangerous,
  });
  const activeGuide = buildWorkspacePrimer({
    rootPath: input.rootPath,
    rules: input.rules,
    planningEnabled: input.planningEnabled,
    sessionMemoryId: session.sessionId,
  });
  const allowedTools: OmniBootstrapTool[] = input.baseAllowlist.map((t) => ({
    name: t.name,
    description: t.description,
    dangerous: false,
    allowed: true,
  }));
  const dangerousTools: OmniBootstrapTool[] = input.dangerousTools.map((t) => ({
    name: t.name,
    description: t.description,
    dangerous: true,
    allowed: input.allowDangerous,
  }));
  return {
    sessionId: session.sessionId,
    workspace: {
      rootPath: input.rootPath,
      name: path.basename(input.rootPath) || input.rootPath,
      detectedAt: session.issuedAt,
    },
    activeGuide,
    rules: input.rules,
    tools: [...allowedTools, ...dangerousTools],
    policy: {
      mustCallBootstrapFirst: true,
      sessionTtlMs: input.sessionTtlMs,
      allowDangerous: input.allowDangerous,
      deniedNativeTools: OMNI_DENIED_NATIVE_TOOLS,
    },
    serverInstructions: input.serverInstructions,
  };
};
