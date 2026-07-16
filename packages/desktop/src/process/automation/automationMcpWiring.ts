/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wires the agent-facing Automation MCP server for the Main process. Assembles
 * the {@link AutomationServerDeps} from the shared automation store + engine
 * (the same single source of truth the UI plane and the IPC bridge use) and
 * starts the in-process SSE host.
 *
 * One service, two planes: a workflow an agent creates here appears on the
 * Automation page and vice-versa — there is no second store or engine.
 *
 * Process boundary: Main-process (Node.js / Electron) module.
 */

import { cancelWorkflowRun, getSharedAutomationServices, startWorkflowRun } from './automationBridge';
import { createAutomationServer, type AutomationServerDeps } from './automationMcpServer';
import { startAutomationMcpHost, type AutomationMcpHost } from './automationMcpHost';

let cachedDeps: AutomationServerDeps | undefined;

/** Build the {@link AutomationServerDeps} from the shared automation services. */
export const getAutomationServerDeps = (): AutomationServerDeps => {
  if (cachedDeps) return cachedDeps;
  const { store } = getSharedAutomationServices();
  cachedDeps = {
    listWorkflows: () => store.list(),
    getWorkflow: (id) => store.get(id),
    saveWorkflow: (workflow) => store.save(workflow),
    removeWorkflow: (id) => store.remove(id),
    runWorkflow: (id) => startWorkflowRun(id),
    cancelRun: (runId) => Promise.resolve(cancelWorkflowRun(runId)),
  };
  return cachedDeps;
};

/** Build the Automation MCP server bound to the shared services. */
export const buildAutomationServer = () => createAutomationServer(getAutomationServerDeps());

/** Start the in-process Automation MCP host bound to the shared services. */
export const startAutomation = (): Promise<AutomationMcpHost> => startAutomationMcpHost(getAutomationServerDeps());
