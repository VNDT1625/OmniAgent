/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in Cron (Scheduled Tasks) MCP server — the **Agent plane** for the
 * scheduled-tasks feature.
 *
 * Every other Tomni Agentic capability (resource, company, browser-control, testing,
 * manager, tool-selector) exposes a built-in MCP server so an agent can use it,
 * while the matching UI plane (`renderer/pages/cron/`) drives the *same* state.
 * Scheduling was the one capability with **no** agent-facing tools — this server
 * closes that gap: it lets an agent list, inspect, create, update, pause/resume,
 * run-now and delete the user's scheduled tasks, all through the SAME aioncore
 * `/api/cron/*` surface the UI uses (single source of truth — a job an agent
 * creates shows up on the Scheduled Tasks page and vice-versa).
 *
 * ## Tool-name convention (snake_case, not dotted)
 *
 * Like the other built-in servers (`browser_open`, `company_create`,
 * `resource_status`, `manager_add_task`) the tools use snake_case
 * (`cron_list_tasks`, `cron_create_task`, …): MCP tools surface to the model as
 * function-calling tools whose names must match `^[a-zA-Z0-9_-]+$`, so a dot
 * separator would break OpenAI/Gemini function calling. The intent matches the
 * design exactly.
 *
 * ## Why a factory + injected deps
 *
 * The server is built as a factory taking {@link CronServerDeps}. In production
 * the host injects the real `cron.*` IPC-bridge invokers (which call aioncore
 * over HTTP from the Main process). In tests we inject fakes, so the tool surface
 * is verified without a live backend.
 *
 * Process boundary: Main-process (Node.js / Electron) module — no DOM APIs.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ICronJob, ICreateCronJobParams } from '@/common/adapter/ipcBridge';
import { BUILTIN_CRON_NAME } from './constants';

/**
 * The slice of the `cron.*` IPC bridge this server needs. Declared structurally
 * (not by importing the bridge object) so the factory stays pure and testable;
 * the host wires the real invokers.
 */
export type CronServiceClient = {
  listJobs: (params?: void) => Promise<ICronJob[]>;
  getJob: (params: { job_id: string }) => Promise<ICronJob | null>;
  addJob: (params: ICreateCronJobParams) => Promise<ICronJob>;
  updateJob: (params: { job_id: string; updates: Partial<ICronJob> }) => Promise<ICronJob>;
  removeJob: (params: { job_id: string }) => Promise<void>;
  runNow: (params: { job_id: string }) => Promise<{ conversation_id: string }>;
};

/** Injected collaborators for {@link createCronServer}. */
export type CronServerDeps = {
  /** The cron service (aioncore-backed in production, faked in tests). */
  cron: CronServiceClient;
  /**
   * Resolve the current IANA time zone for cron expressions. Defaults to the
   * host's zone; injectable so tests are deterministic.
   */
  resolveTimeZone?: () => string;
};

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

/** Resolve the host IANA time zone, falling back to UTC. */
const defaultTimeZone = (): string => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.trim() ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
};

/**
 * Project a full {@link ICronJob} onto a compact, agent-friendly summary. Keeps
 * the model's context small and avoids leaking internal bookkeeping it cannot
 * act on.
 */
const summariseJob = (job: ICronJob) => ({
  id: job.id,
  name: job.name,
  description: job.description,
  enabled: job.enabled,
  schedule: job.schedule,
  prompt: job.target?.payload?.text,
  executionMode: job.target?.execution_mode ?? 'new_conversation',
  agentType: job.metadata?.agent_type,
  createdBy: job.metadata?.created_by,
  nextRunAtMs: job.state?.next_run_at_ms,
  lastRunAtMs: job.state?.last_run_at_ms,
  lastStatus: job.state?.last_status,
  lastError: job.state?.last_error,
  runCount: job.state?.run_count,
});

/**
 * Build the Cron {@link McpServer} bound to the injected cron service.
 *
 * @param deps The cron service client (+ optional time-zone resolver).
 * @returns A configured MCP server; the caller (host) connects a transport.
 */
export const createCronServer = (deps: CronServerDeps): McpServer => {
  const { cron } = deps;
  const resolveTimeZone = deps.resolveTimeZone ?? defaultTimeZone;
  const server = new McpServer({ name: BUILTIN_CRON_NAME, version: '1.0.0' });

  // --- cron_list_tasks -----------------------------------------------------
  server.tool(
    'cron_list_tasks',
    `List the user's scheduled tasks (cron jobs): name, schedule, agent, enabled state and last run.

Use this first to discover existing tasks before creating or modifying one. Returns a JSON array
of compact task summaries (use cron_get_task for a single task's full detail).`,
    {},
    async () => {
      try {
        const jobs = (await cron.listJobs()) ?? [];
        return jsonResult(jobs.map(summariseJob));
      } catch (error) {
        return textResult(`Error listing scheduled tasks: ${describeError(error)}`, true);
      }
    }
  );

  // --- cron_get_task -------------------------------------------------------
  server.tool(
    'cron_get_task',
    `Get the full detail of one scheduled task by id (schedule, prompt, agent config, run history).

Input:
- taskId: the task id (from cron_list_tasks).`,
    {
      taskId: z.string().describe('The scheduled task id to inspect.'),
    },
    async ({ taskId }) => {
      try {
        const job = await cron.getJob({ job_id: taskId });
        if (!job) return textResult(`No scheduled task with id: ${taskId}`, true);
        return jsonResult(job);
      } catch (error) {
        return textResult(`Error reading scheduled task: ${describeError(error)}`, true);
      }
    }
  );

  // --- cron_create_task ----------------------------------------------------
  server.tool(
    'cron_create_task',
    `Create a scheduled task that runs a prompt on a recurring or one-off schedule.

The schedule is a standard 5-field cron expression (minute hour day month weekday), e.g.
"0 9 * * *" = every day at 09:00, "30 8 * * 1-5" = weekdays at 08:30, "0 * * * *" = hourly.
Leave the expression empty ("") for a manual-only task the user/agent triggers via cron_run_now.

The task runs the given prompt with the chosen agent. By default it starts a NEW conversation on
each run (executionMode "new_conversation"); use "existing" to append to the bound conversation.

Input:
- name: short task name (required)
- prompt: the instruction the agent runs each time (required)
- schedule: 5-field cron expression, or "" for manual-only (required)
- scheduleDescription: human-readable description of the cadence (optional; defaults to the expression)
- agentType: execution engine, e.g. "claude" | "gemini" | "codex" | "aionrs" (optional; defaults to "claude")
- executionMode: "new_conversation" (default) | "existing"
- conversationId: bind to an existing conversation (optional; required only for executionMode "existing")
- modelId: specific model id for the agent (optional)

Returns the created task summary including its new id.`,
    {
      name: z.string().describe('Short task name shown in the Scheduled Tasks list.'),
      prompt: z.string().describe('The instruction the agent runs on each trigger.'),
      schedule: z.string().describe('5-field cron expression (e.g. "0 9 * * *"); "" for manual-only.'),
      scheduleDescription: z.string().optional().describe('Human-readable cadence description.'),
      agentType: z.string().optional().describe('Execution engine (claude/gemini/codex/aionrs/…). Default "claude".'),
      executionMode: z.enum(['new_conversation', 'existing']).optional().describe('Default "new_conversation".'),
      conversationId: z
        .string()
        .optional()
        .describe('Existing conversation to append to (for executionMode "existing").'),
      modelId: z.string().optional().describe('Specific model id for the agent.'),
    },
    async ({ name, prompt, schedule, scheduleDescription, agentType, executionMode, conversationId, modelId }) => {
      try {
        const expr = (schedule ?? '').trim();
        const description = scheduleDescription?.trim() || (expr ? expr : 'Manual only');
        const resolvedAgentType = (agentType ?? 'claude').trim() || 'claude';
        const params: ICreateCronJobParams = {
          name,
          schedule: { kind: 'cron', expr, tz: resolveTimeZone(), description },
          prompt,
          conversation_id: conversationId ?? '',
          agent_type: resolvedAgentType,
          created_by: 'agent',
          execution_mode: executionMode ?? 'new_conversation',
          ...(modelId
            ? { agent_config: { backend: resolvedAgentType, name: resolvedAgentType, model_id: modelId } }
            : {}),
        };
        const job = await cron.addJob(params);
        return jsonResult({ created: job.id, task: summariseJob(job) });
      } catch (error) {
        return textResult(`Error creating scheduled task: ${describeError(error)}`, true);
      }
    }
  );

  // --- cron_update_task ----------------------------------------------------
  server.tool(
    'cron_update_task',
    `Update fields of an existing scheduled task (rename, change the prompt, or change the schedule).

Input:
- taskId: the task id (required)
- name: new name (optional)
- prompt: new instruction the agent runs (optional)
- schedule: new 5-field cron expression, or "" for manual-only (optional)
- scheduleDescription: human-readable cadence description (optional; used with schedule)

Only the provided fields are changed. Returns the updated task summary.`,
    {
      taskId: z.string().describe('The scheduled task id to update.'),
      name: z.string().optional().describe('New task name.'),
      prompt: z.string().optional().describe('New instruction the agent runs each trigger.'),
      schedule: z.string().optional().describe('New 5-field cron expression; "" for manual-only.'),
      scheduleDescription: z.string().optional().describe('Human-readable cadence description.'),
    },
    async ({ taskId, name, prompt, schedule, scheduleDescription }) => {
      try {
        const existing = await cron.getJob({ job_id: taskId });
        if (!existing) return textResult(`No scheduled task with id: ${taskId}`, true);

        const updates: Partial<ICronJob> = {};
        if (name !== undefined) updates.name = name;
        if (schedule !== undefined) {
          const expr = schedule.trim();
          const description = scheduleDescription?.trim() || (expr ? expr : 'Manual only');
          updates.schedule = { kind: 'cron', expr, tz: resolveTimeZone(), description };
        }
        if (prompt !== undefined) {
          updates.target = { ...existing.target, payload: { kind: 'message', text: prompt } };
        }
        if (Object.keys(updates).length === 0) {
          return jsonResult({ unchanged: taskId, task: summariseJob(existing) });
        }
        const job = await cron.updateJob({ job_id: taskId, updates });
        return jsonResult({ updated: job.id, task: summariseJob(job) });
      } catch (error) {
        return textResult(`Error updating scheduled task: ${describeError(error)}`, true);
      }
    }
  );

  // --- cron_set_enabled ----------------------------------------------------
  server.tool(
    'cron_set_enabled',
    `Pause or resume a scheduled task. A paused task keeps its definition but does not fire until resumed.

Input:
- taskId: the task id (required)
- enabled: true to resume, false to pause (required)`,
    {
      taskId: z.string().describe('The scheduled task id.'),
      enabled: z.boolean().describe('true = resume (run on schedule), false = pause.'),
    },
    async ({ taskId, enabled }) => {
      try {
        const job = await cron.updateJob({ job_id: taskId, updates: { enabled } });
        return jsonResult({ taskId: job.id, enabled: job.enabled });
      } catch (error) {
        return textResult(`Error changing scheduled task state: ${describeError(error)}`, true);
      }
    }
  );

  // --- cron_run_now --------------------------------------------------------
  server.tool(
    'cron_run_now',
    `Trigger a scheduled task immediately, regardless of its schedule. Useful to test a task or to run
a manual-only task on demand.

Input:
- taskId: the task id (required)

Returns the conversation id the run started in.`,
    {
      taskId: z.string().describe('The scheduled task id to run now.'),
    },
    async ({ taskId }) => {
      try {
        const result = await cron.runNow({ job_id: taskId });
        return jsonResult({ ranTask: taskId, conversationId: result?.conversation_id });
      } catch (error) {
        return textResult(`Error running scheduled task: ${describeError(error)}`, true);
      }
    }
  );

  // --- cron_delete_task ----------------------------------------------------
  server.tool(
    'cron_delete_task',
    `Permanently delete a scheduled task. This cannot be undone; the task and its schedule are removed.

Input:
- taskId: the task id (required)`,
    {
      taskId: z.string().describe('The scheduled task id to delete.'),
    },
    async ({ taskId }) => {
      try {
        await cron.removeJob({ job_id: taskId });
        return jsonResult({ deleted: taskId });
      } catch (error) {
        return textResult(`Error deleting scheduled task: ${describeError(error)}`, true);
      }
    }
  );

  return server;
};
