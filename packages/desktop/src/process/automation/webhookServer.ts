/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Webhook server for the Automation feature — a tiny loopback HTTP listener that
 * fires a workflow when an external system POSTs to its path.
 *
 * A workflow opts in by starting with a `trigger.webhook` node whose config
 * `path` (e.g. `/my-hook`) is the listen path. On `POST <path>` the server runs
 * the matching enabled workflow, passing the parsed JSON (or raw text) body as
 * the run's seed `input`, and replies `{ ok, runId }`.
 *
 * It rebuilds its route table from the store on start and whenever the store
 * changes, so creating/editing a webhook workflow updates routing live. Binds to
 * an ephemeral loopback port (local only — no external exposure without an
 * explicit tunnel).
 *
 * The HTTP server + run trigger are injectable so the router is unit-testable
 * without a real socket.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import * as http from 'node:http';
import type { IAutomationStore } from './automationStore';
import type { Workflow } from './automationTypes';

/** Injectable dependencies for {@link createWebhookServer}. */
export type WebhookServerDeps = {
  /** The workflow store to scan + subscribe to. */
  store: IAutomationStore;
  /** Start a workflow run with a seed input; returns the run id. */
  runWorkflow: (workflowId: string, input: unknown) => Promise<{ runId: string }>;
  /** Max request body size in bytes (guards against huge payloads). Default 1 MB. */
  maxBodyBytes?: number;
};

/** A running webhook server. */
export type WebhookServer = {
  /** The loopback base URL (e.g. `http://127.0.0.1:51234`). */
  url: string;
  /** The port the server listens on. */
  port: number;
  /** Current path → workflowId routes (snapshot). */
  routes: () => Map<string, string>;
  /** Stop the server. */
  close: () => Promise<void>;
};

/** Extract the webhook path from a workflow's first node, or `null`. */
const webhookPath = (workflow: Workflow): string | null => {
  const trigger = workflow.nodes[0];
  if (!trigger || trigger.kind !== 'trigger.webhook') return null;
  const path = (trigger.config as Record<string, unknown>).path;
  if (typeof path !== 'string' || path.trim().length === 0) return null;
  const normalised = path.trim();
  return normalised.startsWith('/') ? normalised : `/${normalised}`;
};

/** Build the path → workflowId route map from enabled webhook workflows. */
export const buildRoutes = (workflows: Workflow[]): Map<string, string> => {
  const routes = new Map<string, string>();
  for (const workflow of workflows) {
    if (!workflow.enabled) continue;
    const path = webhookPath(workflow);
    if (path) routes.set(path, workflow.id);
  }
  return routes;
};

let server: WebhookServer | undefined;

/**
 * Start (once) the in-process webhook server bound to the shared store + run
 * trigger. Reused on subsequent calls.
 */
export const startWebhookServer = async (deps: WebhookServerDeps): Promise<WebhookServer> => {
  if (server) return server;
  const maxBodyBytes = deps.maxBodyBytes ?? 1_000_000;
  let routes = buildRoutes(await deps.store.list());

  // Re-derive routes whenever workflows change.
  deps.store.onChange((workflows) => {
    routes = buildRoutes(workflows);
  });

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBodyBytes) {
          reject(new Error('Request body too large.'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // Only POST to a registered path triggers a workflow.
      if (req.method !== 'POST') {
        res
          .writeHead(405, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ ok: false, error: 'Only POST is supported.' }));
        return;
      }
      const workflowId = routes.get(url.pathname);
      if (!workflowId) {
        res
          .writeHead(404, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ ok: false, error: `No webhook workflow for path: ${url.pathname}` }));
        return;
      }
      try {
        const raw = await readBody(req);
        let input: unknown = raw;
        try {
          input = raw.length > 0 ? JSON.parse(raw) : {};
        } catch {
          input = raw; // not JSON → pass the raw string through
        }
        const { runId } = await deps.runWorkflow(workflowId, input);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, runId }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: message }));
      }
    })();
  });

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('[AutomationWebhook] Could not resolve the loopback port.'));
    });
  });

  server = {
    url: `http://127.0.0.1:${port}`,
    port,
    routes: () => new Map(routes),
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
  console.log(`[AutomationWebhook] Listening on ${server.url} (${routes.size} route(s)).`);
  return server;
};

/** Return the running webhook server, if started. */
export const getWebhookServer = (): WebhookServer | undefined => server;

/** Stop the webhook server (deterministic teardown). */
export const stopWebhookServer = async (): Promise<void> => {
  if (!server) return;
  await server.close();
  server = undefined;
};
