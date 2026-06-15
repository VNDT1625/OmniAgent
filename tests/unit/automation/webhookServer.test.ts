/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the Automation webhook server's pure route-building logic + a live
 * round-trip over a real loopback socket (start → POST → run → stop).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRoutes, startWebhookServer, stopWebhookServer } from '@/process/automation/webhookServer';
import type { IAutomationStore } from '@/process/automation/automationStore';
import type { Workflow } from '@/process/automation/automationTypes';

const hookWf = (id: string, path: string, enabled = true): Workflow => ({
  id,
  name: id,
  nodes: [{ id: 'n1', kind: 'trigger.webhook', name: 'Hook', config: { path } }],
  enabled,
  createdAt: 0,
  updatedAt: 0,
});

const manualWf = (id: string): Workflow => ({
  id,
  name: id,
  nodes: [{ id: 'n1', kind: 'trigger.manual', name: 'Start', config: {} }],
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
});

/** Minimal store stub exposing only what the webhook server uses. */
const stubStore = (workflows: Workflow[]): IAutomationStore => ({
  list: () => Promise.resolve(workflows),
  get: (id) => Promise.resolve(workflows.find((w) => w.id === id)),
  load: () => Promise.resolve(workflows),
  save: () => Promise.resolve(workflows[0]),
  remove: () => Promise.resolve(workflows),
  onChange: () => () => undefined,
});

describe('buildRoutes', () => {
  it('maps enabled webhook workflows by normalised path', () => {
    const routes = buildRoutes([hookWf('w1', '/hook-a'), hookWf('w2', 'hook-b'), manualWf('w3')]);
    expect(routes.get('/hook-a')).toBe('w1');
    expect(routes.get('/hook-b')).toBe('w2'); // leading slash added
    expect(routes.size).toBe(2); // manual workflow excluded
  });

  it('excludes disabled workflows', () => {
    const routes = buildRoutes([hookWf('w1', '/hook', false)]);
    expect(routes.size).toBe(0);
  });
});

describe('startWebhookServer (live)', () => {
  afterEach(async () => {
    await stopWebhookServer();
  });

  it('runs the matching workflow with the POST body as input', async () => {
    const runWorkflow = vi.fn().mockResolvedValue({ runId: 'run-1' });
    const server = await startWebhookServer({ store: stubStore([hookWf('w1', '/my-hook')]), runWorkflow });

    const response = await fetch(`${server.url}/my-hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    const json = (await response.json()) as { ok: boolean; runId: string };

    expect(response.status).toBe(200);
    expect(json).toEqual({ ok: true, runId: 'run-1' });
    expect(runWorkflow).toHaveBeenCalledWith('w1', { hello: 'world' });
  });

  it('returns 404 for an unknown path', async () => {
    const server = await startWebhookServer({ store: stubStore([hookWf('w1', '/known')]), runWorkflow: vi.fn() });
    const response = await fetch(`${server.url}/unknown`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
  });

  it('rejects non-POST methods with 405', async () => {
    const server = await startWebhookServer({ store: stubStore([hookWf('w1', '/known')]), runWorkflow: vi.fn() });
    const response = await fetch(`${server.url}/known`, { method: 'GET' });
    expect(response.status).toBe(405);
  });
});
