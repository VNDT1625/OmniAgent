/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in MCP server for the Personal Manager feature (Requirement 9.3 — the
 * Agent plane).
 *
 * Runs as a standalone stdio process spawned by the MCP client, exposing the
 * user's tasks / notes / calendar to any agent. It reads + writes the SAME
 * `manager-data.json` the UI plane uses, so a task created by an agent shows up
 * in the Manager UI and vice-versa. The data directory is injected via the
 * {@link MANAGER_DATA_DIR_ENV_KEY} env var (the server cannot reach Electron's
 * `app.getPath('userData')`), mirroring the Resource MCP server.
 *
 * Deliberately data-only: these tools never call the LLM (no parse/optimise), to
 * avoid an agent triggering a model loop through its own tools.
 *
 * Process boundary: standalone Node.js process. No Electron, no DOM.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BUILTIN_MANAGER_NAME, MANAGER_DATA_DIR_ENV_KEY } from './constants';
import { createManagerStore } from '@process/manager/managerStore';

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

async function main() {
  const dir = process.env[MANAGER_DATA_DIR_ENV_KEY];
  // The store resolves `userData` lazily only when `dir` is absent; in this
  // standalone process there is no Electron app, so a dir MUST be provided.
  const store = createManagerStore(dir ? { dir } : undefined);
  await store.load();

  const server = new McpServer({ name: BUILTIN_MANAGER_NAME, version: '1.0.0' });

  server.tool(
    'manager_list_tasks',
    "List the user's personal tasks (todos) with status and due dates.",
    {},
    async () => {
      const data = await store.load();
      return text(data.tasks);
    }
  );

  server.tool(
    'manager_add_task',
    'Create a personal task (todo) for the user.',
    {
      title: z.string().describe('Short task title.'),
      description: z.string().optional().describe('Optional details.'),
      kind: z.enum(['oneoff', 'recurring', 'habit', 'milestone']).optional().describe('Task kind. Default oneoff.'),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('Priority. Default medium.'),
      dueAt: z.number().optional().describe('Deadline as a ms-epoch timestamp.'),
    },
    async ({ title, description, kind, priority, dueAt }) => {
      const task = await store.addTask({ title, description, kind, priority, dueAt: dueAt ?? null });
      return text({ created: task.id, task });
    }
  );

  server.tool(
    'manager_update_task',
    'Update fields of an existing task (e.g. mark status, change priority).',
    {
      id: z.string().describe('Task id to update.'),
      status: z.enum(['todo', 'in_progress', 'done']).optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      title: z.string().optional(),
    },
    async ({ id, status, priority, title }) => {
      if (status) {
        await store.setTaskStatus(id, status);
      }
      const patch: Record<string, unknown> = {};
      if (priority) patch.priority = priority;
      if (title) patch.title = title;
      const data = Object.keys(patch).length > 0 ? await store.updateTask(id, patch) : store.getData();
      return text(data.tasks.find((t) => t.id === id) ?? { error: 'task not found', id });
    }
  );

  server.tool(
    'manager_add_note',
    'Create a free-form note (Markdown body) for the user.',
    {
      body: z.string().describe('Note content (Markdown allowed).'),
      title: z.string().optional().describe('Optional note title.'),
    },
    async ({ body, title }) => {
      const note = await store.addNote({ body, title });
      return text({ created: note.id });
    }
  );

  server.tool(
    'manager_list_events',
    "List the user's calendar events (with fixed/flexible lock kind).",
    {},
    async () => {
      const data = await store.load();
      return text(data.events);
    }
  );

  server.tool(
    'manager_add_event',
    'Create a calendar event. Use lockKind "fixed" for immovable commitments (classes, meetings).',
    {
      title: z.string().describe('Event title.'),
      startAt: z.number().describe('Start time as a ms-epoch timestamp.'),
      endAt: z.number().describe('End time as a ms-epoch timestamp.'),
      lockKind: z.enum(['fixed', 'flexible']).optional().describe('Default flexible.'),
      location: z.string().optional(),
    },
    async ({ title, startAt, endAt, lockKind, location }) => {
      const event = await store.addEvent({
        title,
        startAt,
        endAt,
        lockKind: lockKind ?? 'flexible',
        location: location ?? null,
        source: 'manual',
      });
      return text({ created: event.id });
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[ManagerMCP] Fatal error:', error);
  process.exit(1);
});
