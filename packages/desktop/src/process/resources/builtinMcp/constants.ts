/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

// Keep this constant local to avoid pulling in common/config/storage side effects
// when the built-in MCP server boots in a standalone stdio process.
export const BUILTIN_IMAGE_GEN_ID = 'builtin-image-gen';
export const BUILTIN_IMAGE_GEN_NAME = 'aionui-image-generation';
export const BUILTIN_IMAGE_GEN_LEGACY_NAMES = ['AionUi Image Generation', BUILTIN_IMAGE_GEN_ID] as const;

export function isBuiltinImageGenName(name?: string | null): boolean {
  if (!name) return false;
  return (
    name === BUILTIN_IMAGE_GEN_NAME ||
    BUILTIN_IMAGE_GEN_LEGACY_NAMES.includes(name as (typeof BUILTIN_IMAGE_GEN_LEGACY_NAMES)[number])
  );
}

export function isBuiltinImageGenTransport(transport?: {
  type?: string;
  command?: string;
  args?: string[] | null;
}): boolean {
  if (!transport || transport.type !== 'stdio' || transport.command !== 'node') {
    return false;
  }

  return (transport.args || []).some((arg) => typeof arg === 'string' && arg.includes('builtin-mcp-image-gen.js'));
}

// --- Resource status (Requirement 5.9 — read-only Agent-plane view) ---------
// Kept local (like the image-gen constants above) so the standalone stdio
// Resource MCP server can import them without dragging in common/config side
// effects.

/** Stable identifier of the built-in Resource MCP server. */
export const BUILTIN_RESOURCE_ID = 'builtin-resource';

/** Canonical name of the built-in Resource MCP server. */
export const BUILTIN_RESOURCE_NAME = 'aionui-resource';

/** Historic names that may appear in stored configs; treated as the same server. */
export const BUILTIN_RESOURCE_LEGACY_NAMES = ['AionUi Resource', BUILTIN_RESOURCE_ID] as const;

/**
 * Name of the single read-only tool the Resource MCP server exposes.
 *
 * `design.md` refers to this capability as `resource.status`; the existing
 * built-in tool (`aionui_image_generation`) uses snake_case rather than a dot
 * separator, so we follow that convention here while preserving the intent.
 */
export const BUILTIN_RESOURCE_TOOL_NAME = 'resource_status';

/**
 * Environment variable carrying the directory that holds `resource-state.json`.
 *
 * The Resource MCP server runs as a standalone `node` process and therefore
 * cannot reach Electron's `app.getPath('userData')`; the spawning code injects
 * the resolved directory through this variable (mirrors how the image-gen
 * server receives its provider config via env, see `imageGenerationMcpEnv.ts`).
 */
export const RESOURCE_STATE_DIR_ENV_KEY = 'AIONUI_RESOURCE_STATE_DIR';

export function isBuiltinResourceName(name?: string | null): boolean {
  if (!name) return false;
  return (
    name === BUILTIN_RESOURCE_NAME ||
    BUILTIN_RESOURCE_LEGACY_NAMES.includes(name as (typeof BUILTIN_RESOURCE_LEGACY_NAMES)[number])
  );
}

export function isBuiltinResourceTransport(transport?: {
  type?: string;
  command?: string;
  args?: string[] | null;
}): boolean {
  if (!transport || transport.type !== 'stdio' || transport.command !== 'node') {
    return false;
  }

  return (transport.args || []).some((arg) => typeof arg === 'string' && arg.includes('builtin-mcp-resource.js'));
}

// --- Personal Manager (Tasks + Note + Schedule) — Agent-plane MCP server -----
// Kept local (like the constants above) so the standalone stdio Manager MCP
// server can import them without dragging in common/config side effects.

/** Stable identifier of the built-in Manager MCP server. */
export const BUILTIN_MANAGER_ID = 'builtin-manager';

/** Canonical name of the built-in Manager MCP server. */
export const BUILTIN_MANAGER_NAME = 'aionui-manager';

/** Historic names that may appear in stored configs; treated as the same server. */
export const BUILTIN_MANAGER_LEGACY_NAMES = ['AionUi Manager', BUILTIN_MANAGER_ID] as const;

/**
 * Environment variable carrying the directory that holds `manager-data.json`.
 *
 * The Manager MCP server runs as a standalone `node` process and therefore
 * cannot reach Electron's `app.getPath('userData')`; the spawning code injects
 * the resolved directory through this variable (mirrors `RESOURCE_STATE_DIR_ENV_KEY`).
 */
export const MANAGER_DATA_DIR_ENV_KEY = 'AIONUI_MANAGER_DATA_DIR';

export function isBuiltinManagerName(name?: string | null): boolean {
  if (!name) return false;
  return (
    name === BUILTIN_MANAGER_NAME ||
    BUILTIN_MANAGER_LEGACY_NAMES.includes(name as (typeof BUILTIN_MANAGER_LEGACY_NAMES)[number])
  );
}

export function isBuiltinManagerTransport(transport?: {
  type?: string;
  command?: string;
  args?: string[] | null;
}): boolean {
  if (!transport || transport.type !== 'stdio' || transport.command !== 'node') {
    return false;
  }

  return (transport.args || []).some((arg) => typeof arg === 'string' && arg.includes('builtin-mcp-manager.js'));
}

// --- Scheduled Tasks (Cron) — Agent-plane MCP server ------------------------
// The Cron capability lives in aioncore (HTTP `/api/cron/*`) and the existing
// `cron.*` IPC bridge already wraps it. To give an AGENT the same scheduling
// power the UI has, we host an in-process SSE MCP server (mirroring the Testing
// / Browser-Control servers, which also drive live Main-process state) instead
// of a standalone stdio child — the standalone process cannot reach the live
// backend port (`globalThis.__backendPort`). These identifiers are consumed by
// the host + the catalog registration + the renderer "Super" surface.

/** Stable identifier of the built-in Cron MCP server. */
export const BUILTIN_CRON_ID = 'builtin-cron';

/** Canonical name of the built-in Cron MCP server. */
export const BUILTIN_CRON_NAME = 'aionui-cron';

/** Historic names that may appear in stored configs; treated as the same server. */
export const BUILTIN_CRON_LEGACY_NAMES = ['AionUi Cron', BUILTIN_CRON_ID] as const;

export function isBuiltinCronName(name?: string | null): boolean {
  if (!name) return false;
  return (
    name === BUILTIN_CRON_NAME || BUILTIN_CRON_LEGACY_NAMES.includes(name as (typeof BUILTIN_CRON_LEGACY_NAMES)[number])
  );
}

// --- System Insight (Quan sát) — Agent-plane MCP server ---------------------
// Mirrors the Resource / Manager standalone stdio servers: a separate `node`
// process that reads the persisted `system-snapshot.json` (written by the live
// sampler) rather than reaching the Electron Main-process service. This lets an
// agent see the whole machine — static profile + live CPU/RAM/per-process — in
// one read instead of running ad-hoc shell code. Read-only.

/** Stable identifier of the built-in System Insight MCP server. */
export const BUILTIN_SYSTEM_ID = 'builtin-system';

/** Canonical name of the built-in System Insight MCP server. */
export const BUILTIN_SYSTEM_NAME = 'aionui-system';

/** Historic names that may appear in stored configs; treated as the same server. */
export const BUILTIN_SYSTEM_LEGACY_NAMES = ['AionUi System', BUILTIN_SYSTEM_ID] as const;

/** Name of the single read-only tool the System Insight MCP server exposes. */
export const BUILTIN_SYSTEM_TOOL_NAME = 'system_status';

/**
 * Environment variable carrying the directory that holds `system-snapshot.json`.
 *
 * The System MCP server runs as a standalone `node` process and cannot reach
 * Electron's `app.getPath('userData')`; the spawning code injects the resolved
 * directory through this variable (mirrors `RESOURCE_STATE_DIR_ENV_KEY`).
 */
export const SYSTEM_SNAPSHOT_DIR_ENV_KEY = 'AIONUI_SYSTEM_SNAPSHOT_DIR';

export function isBuiltinSystemName(name?: string | null): boolean {
  if (!name) return false;
  return (
    name === BUILTIN_SYSTEM_NAME ||
    BUILTIN_SYSTEM_LEGACY_NAMES.includes(name as (typeof BUILTIN_SYSTEM_LEGACY_NAMES)[number])
  );
}

export function isBuiltinSystemTransport(transport?: {
  type?: string;
  command?: string;
  args?: string[] | null;
}): boolean {
  if (!transport || transport.type !== 'stdio' || transport.command !== 'node') {
    return false;
  }
  return (transport.args || []).some((arg) => typeof arg === 'string' && arg.includes('builtin-mcp-system.js'));
}
