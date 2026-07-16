/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in MCP server for resource status (Requirement 5.9 — Agent plane).
 *
 * Runs as a standalone stdio process spawned by the MCP client, mirroring
 * `imageGenServer.ts`. It exposes a single **read-only** tool so an agent can
 * see whether the host machine is under load and self-throttle.
 *
 * Important boundary: this tool only *reports* the coordinator's state. It does
 * NOT request or grant leases and never mutates anything — leasing stays an
 * internal-service responsibility (design note: "việc xin lease vẫn do service
 * nội bộ làm"; agents do not allocate resources to themselves).
 *
 * Because this server boots in a separate `node` process (not the Electron Main
 * process), it cannot reach the live {@link IResourceCoordinator} singleton or
 * Electron's `app.getPath`. Instead it reads the persisted `resource-state.json`
 * the coordinator writes — the cross-process source of truth — from the
 * directory passed via {@link RESOURCE_STATE_DIR_ENV_KEY}. This keeps the
 * bundle free of Electron/storage side effects, matching the standalone pattern
 * established by the image-gen server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BUILTIN_RESOURCE_NAME, BUILTIN_RESOURCE_TOOL_NAME, RESOURCE_STATE_DIR_ENV_KEY } from './constants';
// Type-only import — erased at compile time, so it adds no runtime dependency
// (and `leaseTypes` is pure types with no Electron/Node imports anyway).
import type { ResourceState, TaskKind } from '@process/resource/leaseTypes';

/** Name of the persisted state file the coordinator writes (see `resourceState.ts`). */
const RESOURCE_STATE_FILE = 'resource-state.json';

/** Most-recent automatic budget adjustments to surface in the summary. */
const RECENT_ADJUSTMENTS_LIMIT = 5;

/** Compact, agent-friendly projection of {@link ResourceState}. */
type ResourceStatusSummary = {
  /** Static host profile (RAM, CPU cores, discrete GPU, free disk). */
  machine: ResourceState['machine'];
  /** `detailed` (manual) or `suggest` (self-balancing). */
  mode: ResourceState['mode'];
  /** Active quick level, or `custom` when the budget was edited manually. */
  preset: ResourceState['preset'];
  /** Current enforced budget (per-kind concurrency + memory ceilings). */
  budget: ResourceState['budget'];
  /** Number of leases currently held by running heavy tasks. */
  activeLeaseCount: number;
  /** Active lease count broken down by {@link TaskKind}. */
  activeByKind: Partial<Record<TaskKind, number>>;
  /** Number of tasks waiting for a lease because the budget is exhausted. */
  queuedCount: number;
  /** Sum of `estCostMB` across all active leases (vs `budget.maxTotalMemoryMB`). */
  activeMemoryMB: number;
  /** Most recent automatic budget-adjustment reasons (newest last). */
  recentAdjustmentReasons: Array<{ at: number; reason: string }>;
};

/** Type guard: a parsed JSON value is shaped like a {@link ResourceState}. */
function isResourceStateShape(value: unknown): value is ResourceState {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<ResourceState>;
  return (
    typeof candidate.budget === 'object' &&
    candidate.budget !== null &&
    Array.isArray(candidate.active) &&
    Array.isArray(candidate.queued) &&
    Array.isArray(candidate.lastAdjustments)
  );
}

/**
 * Read and validate the persisted {@link ResourceState}.
 *
 * Returns `null` when the state directory is not configured, the file does not
 * exist yet, or the JSON is unreadable/malformed — all of which are reported to
 * the agent as "status unavailable" rather than throwing.
 */
function readResourceState(): ResourceState | null {
  const dir = process.env[RESOURCE_STATE_DIR_ENV_KEY];
  if (!dir) return null;
  try {
    const raw = fs.readFileSync(path.join(dir, RESOURCE_STATE_FILE), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return isResourceStateShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Project a full {@link ResourceState} into the compact agent summary. */
function summarize(state: ResourceState): ResourceStatusSummary {
  const activeByKind: Partial<Record<TaskKind, number>> = {};
  let activeMemoryMB = 0;
  for (const lease of state.active) {
    activeByKind[lease.kind] = (activeByKind[lease.kind] ?? 0) + 1;
    activeMemoryMB += lease.estCostMB;
  }

  return {
    machine: state.machine,
    mode: state.mode,
    preset: state.preset,
    budget: state.budget,
    activeLeaseCount: state.active.length,
    activeByKind,
    queuedCount: state.queued.length,
    activeMemoryMB,
    recentAdjustmentReasons: state.lastAdjustments
      .slice(-RECENT_ADJUSTMENTS_LIMIT)
      .map((adjustment) => ({ at: adjustment.at, reason: adjustment.reason })),
  };
}

/** Human-readable line summarising overall pressure, for the text payload. */
function describePressure(summary: ResourceStatusSummary): string {
  const { activeMemoryMB, budget, queuedCount } = summary;
  const ceiling = budget.maxTotalMemoryMB;
  const usedPct = ceiling > 0 ? Math.round((activeMemoryMB / ceiling) * 100) : 0;
  const loaded = queuedCount > 0 || usedPct >= 80;
  const advice = loaded
    ? 'The machine is under load — prefer fewer concurrent heavy tasks and lighter operations.'
    : 'The machine has spare capacity for heavy tasks.';
  return `Heavy-task memory: ${activeMemoryMB}MB / ${ceiling}MB (${usedPct}%). Queued: ${queuedCount}. ${advice}`;
}

async function main() {
  const server = new McpServer({
    name: BUILTIN_RESOURCE_NAME,
    version: '1.0.0',
  });

  server.tool(
    BUILTIN_RESOURCE_TOOL_NAME,
    `READ-ONLY tool that reports the current host resource status from the AionUi ResourceCoordinator.

Use this BEFORE starting any heavy work (spawning extra agents, opening browser tabs, running tests, transcription, document conversion, semantic indexing, etc.) to check whether the machine is under load, then self-throttle accordingly.

Returns a JSON summary plus a short text assessment:
- machine: total RAM (MB), CPU cores, discrete GPU presence, free disk (MB)
- mode: "detailed" (user-managed) or "suggest" (auto-balancing)
- preset: "saver" | "balanced" | "performance" | "custom"
- budget: per-task-kind concurrency limits + total heavy-task memory ceiling + RAM reserved for the user
- activeLeaseCount / activeByKind: how many heavy tasks are currently running, by kind
- queuedCount: tasks waiting because the budget is exhausted
- activeMemoryMB: estimated RAM held by running heavy tasks (compare against budget.maxTotalMemoryMB)
- recentAdjustmentReasons: why the coordinator recently rescaled the budget

This tool takes NO input and CANNOT change anything. It does not request or grant leases — resource leasing is performed by internal services on the agent's behalf; an agent never allocates resources to itself.`,
    async () => {
      const state = readResourceState();
      if (!state) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Resource status is unavailable. The ResourceCoordinator has not persisted its state yet, or the state directory was not provided to this server. Proceed conservatively.',
            },
          ],
        };
      }

      const summary = summarize(state);
      return {
        content: [
          { type: 'text' as const, text: describePressure(summary) },
          { type: 'text' as const, text: JSON.stringify(summary, null, 2) },
        ],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[ResourceMCP] Fatal error:', error);
  process.exit(1);
});
