/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in Automation MCP server — the **Agent plane** for the n8n-style
 * workflow engine.
 *
 * This is "direction 2" of the Automation feature: while the renderer page
 * (`renderer/pages/automation/`) lets the *user* build and run workflows, this
 * server lets an *AI agent* (Claude / GPT / Gemini) do the same through MCP
 * tool calls — list, inspect, create, run, cancel, delete, and enable/disable
 * workflows, all against the same {@link IAutomationStore} + engine the UI uses
 * (single source of truth).
 *
 * ## Design mirrors cronServer.ts
 *
 * - Factory `createAutomationServer(deps)` — injected deps keep the server pure
 *   and testable without a live backend.
 * - Uses `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`.
 * - Zod schemas for every tool input.
 * - `textResult` / `jsonResult` helpers for consistent MCP payloads.
 * - Tool names follow the `automation_*` snake_case convention (matches
 *   `^[a-zA-Z0-9_-]+$` required by OpenAI / Gemini function calling).
 *
 * Process boundary: Main-process (Node.js / Electron) module — no DOM APIs.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Workflow, WorkflowNode } from './automationTypes';

// ---------------------------------------------------------------------------
// Public constant
// ---------------------------------------------------------------------------

/** Canonical MCP server name for the built-in Automation server. */
export const BUILTIN_AUTOMATION_NAME = 'aionui-automation';

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

/**
 * The slice of the Automation service this MCP server needs. Declared
 * structurally so the factory stays pure and testable; the host wires the real
 * store/engine invokers.
 */
export type AutomationServerDeps = {
  /** Return all saved workflows. */
  listWorkflows: () => Promise<Workflow[]>;
  /** Return one workflow by id, or `undefined` if not found. */
  getWorkflow: (id: string) => Promise<Workflow | undefined>;
  /**
   * Upsert a workflow. A missing / blank `id` creates a new workflow; a
   * present `id` updates the existing one.
   */
  saveWorkflow: (workflow: Partial<Workflow> & { name: string }) => Promise<Workflow>;
  /** Delete a workflow by id and return the remaining list. */
  removeWorkflow: (id: string) => Promise<Workflow[]>;
  /** Start a workflow run and return the assigned run id. */
  runWorkflow: (id: string) => Promise<{ runId: string }>;
  /** Abort an in-flight run by run id. */
  cancelRun: (runId: string) => Promise<void>;
};

// ---------------------------------------------------------------------------
// MCP payload helpers (mirrors cronServer.ts)
// ---------------------------------------------------------------------------

/** Standard MCP text payload, optionally flagged as an error. */
const textResult = (
  text: string,
  isError = false
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } => ({
  content: [{ type: 'text' as const, text }],
  ...(isError ? { isError: true } : {}),
});

/** JSON text payload (pretty-printed) — used for read tools. */
const jsonResult = (value: unknown) => textResult(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

/** Stringify any caught error for an MCP text payload. */
const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Compact workflow summary (keeps model context small)
// ---------------------------------------------------------------------------

/**
 * Project a full {@link Workflow} onto a compact, agent-friendly summary.
 * Avoids sending the full node array on list calls; the agent can call
 * `automation_get_workflow` for the full detail.
 */
const summariseWorkflow = (wf: Workflow) => ({
  id: wf.id,
  name: wf.name,
  description: wf.description,
  enabled: wf.enabled,
  nodeCount: wf.nodes.length,
  triggerKind: wf.nodes[0]?.kind ?? null,
  createdAt: wf.createdAt,
  updatedAt: wf.updatedAt,
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the Automation {@link McpServer} bound to the injected deps.
 *
 * @param deps Automation service methods (store + engine in production, fakes in tests).
 * @returns A configured MCP server; the caller (host) connects a transport.
 */
export const createAutomationServer = (deps: AutomationServerDeps): McpServer => {
  const server = new McpServer({ name: BUILTIN_AUTOMATION_NAME, version: '1.0.0' });

  // -------------------------------------------------------------------------
  // automation_list_workflows
  // -------------------------------------------------------------------------
  server.tool(
    'automation_list_workflows',
    `List all saved automation workflows: id, name, enabled state, node count, and trigger kind.

Use this first to discover existing workflows before creating, modifying, or running one.
Returns a JSON array of compact summaries (call automation_get_workflow for full node detail).`,
    {},
    async () => {
      try {
        const workflows = await deps.listWorkflows();
        return jsonResult(workflows.map(summariseWorkflow));
      } catch (error) {
        return textResult(`Error listing workflows: ${describeError(error)}`, true);
      }
    }
  );

  // -------------------------------------------------------------------------
  // automation_get_workflow
  // -------------------------------------------------------------------------
  server.tool(
    'automation_get_workflow',
    `Get the full detail of one automation workflow by id, including all nodes and their configs.

Use this after automation_list_workflows to inspect a specific workflow before editing or running it.

Input:
- workflowId: the workflow id (from automation_list_workflows).`,
    {
      workflowId: z.string().describe('The workflow id to inspect.'),
    },
    async ({ workflowId }) => {
      try {
        const wf = await deps.getWorkflow(workflowId);
        if (!wf) return textResult(`No workflow found with id: ${workflowId}`, true);
        return jsonResult(wf);
      } catch (error) {
        return textResult(`Error fetching workflow: ${describeError(error)}`, true);
      }
    }
  );

  // -------------------------------------------------------------------------
  // automation_create_workflow
  // -------------------------------------------------------------------------
  server.tool(
    'automation_create_workflow',
    `Create a new automation workflow from a JSON node spec.

A workflow is a linear pipeline: nodes execute in array order, each receiving the previous
node's output as its input. The first node is typically a trigger (trigger.manual,
trigger.schedule, trigger.webhook); subsequent nodes are actions or control-flow steps.

Each node object must have:
- id: unique string within the workflow
- kind: one of the WorkflowNodeKind values (e.g. "trigger.manual", "action.http", "action.ai",
  "action.transform", "action.delay", "action.log", "control.if", "control.loop", etc.)
- name: human-readable label
- config: kind-specific configuration object (see workflow documentation for per-kind shapes)

Input:
- name: display name for the workflow (required)
- nodes: JSON string — a serialised array of WorkflowNode objects (required)
- description: optional longer description

Returns the created workflow id and a compact summary.`,
    {
      name: z.string().describe('Display name for the new workflow.'),
      nodes: z.string().describe('JSON-serialised array of WorkflowNode objects that form the pipeline.'),
      description: z.string().optional().describe('Optional longer description of the workflow.'),
    },
    async ({ name, nodes, description }) => {
      // Validate the nodes JSON before touching the store.
      let parsedNodes: WorkflowNode[];
      try {
        const raw: unknown = JSON.parse(nodes);
        if (!Array.isArray(raw)) {
          return textResult('Invalid nodes: expected a JSON array of WorkflowNode objects.', true);
        }
        parsedNodes = raw as WorkflowNode[];
      } catch (parseError) {
        return textResult(`Invalid nodes JSON: ${describeError(parseError)}`, true);
      }

      try {
        const saved = await deps.saveWorkflow({
          name,
          nodes: parsedNodes,
          ...(description !== undefined ? { description } : {}),
          enabled: true,
        });
        return jsonResult({ created: saved.id, workflow: summariseWorkflow(saved) });
      } catch (error) {
        return textResult(`Error creating workflow: ${describeError(error)}`, true);
      }
    }
  );

  // -------------------------------------------------------------------------
  // automation_run_workflow
  // -------------------------------------------------------------------------
  server.tool(
    'automation_run_workflow',
    `Start an automation workflow run immediately. The run executes asynchronously; events are
streamed to the Automation page in real time.

Use automation_list_workflows or automation_get_workflow first to confirm the workflow exists
and is correctly configured before running it.

Input:
- workflowId: the workflow id to run (required)

Returns the runId assigned to this execution. Use automation_cancel_run with this runId to
abort the run if needed.`,
    {
      workflowId: z.string().describe('The workflow id to run.'),
    },
    async ({ workflowId }) => {
      try {
        const result = await deps.runWorkflow(workflowId);
        return jsonResult({ workflowId, runId: result.runId });
      } catch (error) {
        return textResult(`Error starting workflow run: ${describeError(error)}`, true);
      }
    }
  );

  // -------------------------------------------------------------------------
  // automation_cancel_run
  // -------------------------------------------------------------------------
  server.tool(
    'automation_cancel_run',
    `Abort an in-flight workflow run. The run is cancelled cooperatively; nodes that have already
completed are not rolled back.

Use this when a run is taking too long, was started by mistake, or needs to be stopped before
it reaches a destructive step.

Input:
- runId: the run id returned by automation_run_workflow (required)`,
    {
      runId: z.string().describe('The run id to cancel (from automation_run_workflow).'),
    },
    async ({ runId }) => {
      try {
        await deps.cancelRun(runId);
        return jsonResult({ cancelled: runId });
      } catch (error) {
        return textResult(`Error cancelling run: ${describeError(error)}`, true);
      }
    }
  );

  // -------------------------------------------------------------------------
  // automation_delete_workflow
  // -------------------------------------------------------------------------
  server.tool(
    'automation_delete_workflow',
    `Permanently delete an automation workflow. This cannot be undone; the workflow definition
and its schedule (if any) are removed. Any in-flight runs are NOT automatically cancelled —
call automation_cancel_run first if needed.

Input:
- workflowId: the workflow id to delete (required)`,
    {
      workflowId: z.string().describe('The workflow id to delete.'),
    },
    async ({ workflowId }) => {
      try {
        const remaining = await deps.removeWorkflow(workflowId);
        return jsonResult({ deleted: workflowId, remainingCount: remaining.length });
      } catch (error) {
        return textResult(`Error deleting workflow: ${describeError(error)}`, true);
      }
    }
  );

  // -------------------------------------------------------------------------
  // automation_enable_workflow
  // -------------------------------------------------------------------------
  server.tool(
    'automation_enable_workflow',
    `Enable or disable an automation workflow. A disabled workflow keeps its definition but will
not be triggered automatically (e.g. by a trigger.schedule node). It can still be run manually
via automation_run_workflow.

Use this to pause a workflow temporarily without deleting it, or to re-activate one that was
previously disabled.

Input:
- workflowId: the workflow id (required)
- enabled: true to enable, false to disable (required)`,
    {
      workflowId: z.string().describe('The workflow id to enable or disable.'),
      enabled: z.boolean().describe('true = enable (allow automatic triggers), false = disable.'),
    },
    async ({ workflowId, enabled }) => {
      try {
        const wf = await deps.getWorkflow(workflowId);
        if (!wf) return textResult(`No workflow found with id: ${workflowId}`, true);

        const updated = await deps.saveWorkflow({ ...wf, enabled });
        return jsonResult({ workflowId: updated.id, enabled: updated.enabled });
      } catch (error) {
        return textResult(`Error updating workflow enabled state: ${describeError(error)}`, true);
      }
    }
  );

  return server;
};
