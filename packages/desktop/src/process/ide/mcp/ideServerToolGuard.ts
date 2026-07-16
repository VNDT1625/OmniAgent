/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool-call guard contract used by {@link createIdeServer} so the same factory
 * can be reused by both the internal IDE host (no guard → no behavioural
 * change) and the Omni External MCP Gateway (guard enforces "must call
 * `omni_bootstrap_session` first" + the external allowlist).
 *
 * The guard runs synchronously BEFORE the real tool handler. When it denies,
 * the server returns an MCP `isError:true` text result with the supplied
 * `reason`, never invoking the underlying service.
 */

/** A guard's verdict on a single tool call. */
export type ToolGuardResult = { allow: true } | { allow: false; reason: string };

/**
 * Synchronous guard called with the tool name and its raw argument object
 * (already validated by zod). The guard may inspect both to enforce
 * per-session, per-tool, or per-argument policy.
 */
export type ToolGuard = (toolName: string, args: unknown) => ToolGuardResult;
