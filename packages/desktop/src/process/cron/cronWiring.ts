/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wires the agent-facing Cron MCP server (Scheduled Tasks — Agent plane) for the
 * Main process. It assembles the {@link CronServerDeps} from the real `cron.*`
 * IPC-bridge invokers (which call aioncore's `/api/cron/*` over HTTP) and starts
 * the in-process SSE host.
 *
 * ## One service, two planes
 *
 * The Agent plane drives the **same** aioncore cron surface the UI plane
 * (`renderer/pages/cron/`) uses — a task an agent creates appears on the
 * Scheduled Tasks page and vice-versa. We deliberately do not add a second
 * scheduler; the `cron` bridge is the single source of truth.
 *
 * Process boundary: Main-process (Node.js / Electron) module.
 */

import { cron } from '@/common/adapter/ipcBridge';
import { createCronServer, type CronServerDeps, type CronServiceClient } from '../resources/builtinMcp/cronServer';
import { startCronMcpHost, type CronMcpHost } from './cronMcpHost';

/** Lazily-built deps so the host + register step share one assembly. */
let cachedDeps: CronServerDeps | undefined;

/**
 * Build the {@link CronServerDeps} from the real `cron` IPC bridge.
 *
 * The bridge invokers already map onto aioncore's REST contract, so we just
 * project them onto the structural {@link CronServiceClient} the server expects.
 */
export const getCronServerDeps = (): CronServerDeps => {
  if (cachedDeps) return cachedDeps;
  const client: CronServiceClient = {
    listJobs: () => cron.listJobs.invoke(),
    getJob: (params) => cron.getJob.invoke(params),
    addJob: (params) => cron.addJob.invoke(params),
    updateJob: (params) => cron.updateJob.invoke(params),
    removeJob: (params) => cron.removeJob.invoke(params),
    runNow: (params) => cron.runNow.invoke(params),
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
