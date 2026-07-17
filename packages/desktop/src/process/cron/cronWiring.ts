/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wires the agent-facing Cron MCP server (Scheduled Tasks — Agent plane) for the
 * Main process. It assembles the {@link CronServerDeps} from the Tomny Core scheduled-task
 * compatibility adapter and starts
 * the in-process SSE host.
 *
 * ## One service, two planes
 *
 * The Agent plane drives the **same** Tomny Core schedule store the UI plane
 * (`renderer/pages/cron/`) uses — a task an agent creates appears on the
 * Scheduled Tasks page and vice-versa. We deliberately do not add a second
 * scheduler; `scheduled-tasks.json` is the single source of truth.
 *
 * Process boundary: Main-process (Node.js / Electron) module.
 */

import { getLegacyCronAdapter } from './scheduledTasks';
import { createCronServer, type CronServerDeps, type CronServiceClient } from '../resources/builtinMcp/cronServer';
import { startCronMcpHost, type CronMcpHost } from './cronMcpHost';

/** Lazily-built deps so the host + register step share one assembly. */
let cachedDeps: CronServerDeps | undefined;

/**
 * Build the {@link CronServerDeps} from Tomny Core's compatibility adapter.
 *
 * Both the renderer IPC surface and this MCP client project the same direct-core
 * service onto the structural {@link CronServiceClient} contract.
 */
export const getCronServerDeps = (): CronServerDeps => {
  if (cachedDeps) return cachedDeps;
  const client: CronServiceClient = {
    listJobs: () => getLegacyCronAdapter().listJobs(),
    getJob: (params) => getLegacyCronAdapter().getJob(params),
    addJob: (params) => getLegacyCronAdapter().addJob(params),
    updateJob: (params) => getLegacyCronAdapter().updateJob(params),
    removeJob: (params) => getLegacyCronAdapter().removeJob(params),
    runNow: (params) => getLegacyCronAdapter().runNow(params),
  };
  cachedDeps = { cron: client };
  return cachedDeps;
};

/**
 * Build the Cron MCP server bound to the real cron service. Exposed for the host
 * and for any in-process consumer that wants a fresh server instance.
 */
export const buildCronServer = () => createCronServer(getCronServerDeps());

/**
 * Start the in-process Cron MCP host bound to the real cron service.
 *
 * @returns The running host (url + port + close).
 */
export const startCron = (): Promise<CronMcpHost> => startCronMcpHost(getCronServerDeps());
