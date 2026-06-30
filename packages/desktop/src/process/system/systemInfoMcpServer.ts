/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in MCP server for System Insight (Agent plane).
 *
 * Runs as a standalone stdio process spawned by the MCP client, mirroring
 * `resourceServer.ts`. It exposes a single **read-only** tool so an agent can
 * see the whole machine — static profile + live CPU/RAM/per-process metrics —
 * in one call instead of running ad-hoc shell commands (`top`, `wmic`, ...).
 *
 * Because this server boots in a separate `node` process (not the Electron Main
 * process), it cannot reach the live System Insight service or Electron APIs.
 * Instead it reads the `system-snapshot.json` the sampler periodically writes —
 * the cross-process source of truth — from the directory passed via
 * {@link SYSTEM_SNAPSHOT_DIR_ENV_KEY}.
 *
 * Process boundary: standalone Node.js — no Electron, no DOM APIs.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BUILTIN_SYSTEM_NAME,
  BUILTIN_SYSTEM_TOOL_NAME,
  SYSTEM_SNAPSHOT_DIR_ENV_KEY,
} from '../resources/builtinMcp/constants';
// Type-only import — erased at compile time, adds no runtime dependency.
import type { SystemSnapshot } from './systemInfoTypes';

/** Name of the persisted snapshot file the sampler writes. */
const SYSTEM_SNAPSHOT_FILE = 'system-snapshot.json';

/** Cap the per-process list in the agent summary to keep the payload compact. */
const TOP_PROCESS_LIMIT = 12;

/** Type guard: a parsed JSON value is shaped like a {@link SystemSnapshot}. */
function isSnapshotShape(value: unknown): value is SystemSnapshot {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<SystemSnapshot>;
  return (
    typeof candidate.static === 'object' &&
    candidate.static !== null &&
    typeof candidate.live === 'object' &&
    candidate.live !== null
  );
}

/** Read and validate the persisted snapshot; `null` when unavailable/malformed. */
function readSnapshot(): SystemSnapshot | null {
  const dir = process.env[SYSTEM_SNAPSHOT_DIR_ENV_KEY];
  if (!dir) return null;
  try {
    const raw = fs.readFileSync(path.join(dir, SYSTEM_SNAPSHOT_FILE), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return isSnapshotShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A compact, agent-friendly projection of the full snapshot. */
function summarize(snapshot: SystemSnapshot) {
  const { static: profile, live } = snapshot;
  return {
    os: `${profile.os.type} ${profile.os.release} (${profile.os.arch})`,
    hostname: profile.os.hostname,
    cpu: { model: profile.cpu.model, cores: profile.cpu.logicalCores, speedMHz: profile.cpu.speedMHz },
    gpus: profile.gpus.map((gpu) => `${gpu.vendor} ${gpu.model}`.trim()),
    totalMemoryMB: profile.totalMemoryMB,
    disks: profile.disks.map((disk) => ({ mount: disk.mount, freeMB: disk.freeMB, totalMB: disk.totalMB })),
    versions: profile.versions,
    live: {
      sampledAt: live.sampledAt,
      cpuPercent: live.cpu.overallPercent,
      memoryUsedMB: live.memory.usedMB,
      memoryTotalMB: live.memory.totalMB,
      memoryUsedPercent: live.memory.usedPercent,
      loadAvg: live.loadAvg,
      uptimeSec: live.uptimeSec,
      onBattery: live.power.onBattery,
      topProcesses: live.processes.slice(0, TOP_PROCESS_LIMIT).map((process) => ({
        pid: process.pid,
        name: process.name,
        type: process.type,
        cpuPercent: process.cpuPercent,
        memoryMB: process.memoryMB,
      })),
    },
  };
}

/** Human-readable headline for the text payload. */
function describe(summary: ReturnType<typeof summarize>): string {
  const { cpu, live } = summary;
  const pressure =
    live.cpuPercent >= 85 || live.memoryUsedPercent >= 90
      ? 'under heavy load'
      : live.cpuPercent >= 50 || live.memoryUsedPercent >= 70
        ? 'moderately busy'
        : 'idle / light';
  return `Host ${summary.hostname}: ${cpu.model} (${cpu.cores} cores). CPU ${live.cpuPercent}%, RAM ${live.memoryUsedMB}/${live.memoryTotalMB}MB (${live.memoryUsedPercent}%). The machine is currently ${pressure}.`;
}

async function main() {
  const server = new McpServer({ name: BUILTIN_SYSTEM_NAME, version: '1.0.0' });

  server.tool(
    BUILTIN_SYSTEM_TOOL_NAME,
    `READ-ONLY tool that reports the host computer's status from AionUi's System Insight feature.

Use this INSTEAD of running shell commands (top, ps, wmic, systeminfo, free, df, ...) to inspect the machine. It returns a single JSON snapshot plus a short text assessment:
- os / hostname / cpu (model, cores, speed) / gpus / totalMemoryMB / disks / versions — the static host profile
- live.cpuPercent, live.memoryUsedMB / memoryUsedPercent, live.loadAvg, live.uptimeSec, live.onBattery — current measurements
- live.topProcesses — the heaviest processes right now (pid, name, type, cpuPercent, memoryMB)

The data comes from a snapshot the app refreshes every few seconds, so it reflects the recent state without you spawning any process. This tool takes NO input and CANNOT change anything.`,
    async () => {
      const snapshot = readSnapshot();
      if (!snapshot) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'System status is unavailable. The System Insight sampler has not persisted a snapshot yet, or the snapshot directory was not provided to this server.',
            },
          ],
        };
      }
      const summary = summarize(snapshot);
      return {
        content: [
          { type: 'text' as const, text: describe(summary) },
          { type: 'text' as const, text: JSON.stringify(summary, null, 2) },
        ],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[SystemMCP] Fatal error:', error);
  process.exit(1);
});
