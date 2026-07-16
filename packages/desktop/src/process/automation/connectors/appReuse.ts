/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * App-reuse connectors — Automation leaf nodes that drive *existing* AionUi
 * features instead of re-implementing them:
 *
 *  - `action.notify`       → a desktop notification.
 *  - `action.manager`      → create a task / note / event in Personal Manager.
 *  - `action.browser`      → run a web-agent task and return its result.
 *  - `action.conversation` → send a message to an agent conversation, await reply.
 *  - `action.cron`         → create a scheduled task (aioncore `/api/cron`).
 *  - `action.subworkflow`  → run another saved workflow and return its output.
 *
 * Every capability is injected as a plain async function ({@link AppReuseDeps}),
 * so this module has no direct dependency on Electron, aioncore, or the other
 * subsystems — the bridge wires the real implementations, tests pass stubs.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type {
  BrowserNodeConfig,
  ConversationNodeConfig,
  CronNodeConfig,
  ManagerNodeConfig,
  NotifyNodeConfig,
  SubworkflowNodeConfig,
} from '../automationTypes';
import { substituteInput } from './artifacts';

/** Injected capabilities (each defaults to "not wired" → a clear error). */
export type AppReuseDeps = {
  /** Show a desktop notification. */
  notify?: (title: string, body: string) => Promise<void> | void;
  /** Create a Personal Manager entity; returns its id. */
  createManagerEntity?: (
    entity: 'task' | 'note' | 'event',
    payload: { title: string; detail?: string; at?: string }
  ) => Promise<string>;
  /** Run a web-agent task; returns its textual result. */
  runBrowserTask?: (task: string, options: { url?: string; model?: string }) => Promise<string>;
  /** Send a message to an agent conversation; returns the reply text. */
  sendConversation?: (message: string, options: { model?: string }) => Promise<string>;
  /** Create a scheduled task; returns its id. */
  createCronJob?: (payload: { cron: string; prompt: string; name?: string }) => Promise<string>;
  /** Run another workflow by id; returns its final output. */
  runSubworkflow?: (workflowId: string, input: unknown) => Promise<unknown>;
};

const required = <T>(fn: T | undefined, node: string, capability: string): T => {
  if (!fn) throw new Error(`"${node}" is not available: ${capability} is not wired.`);
  return fn;
};

/** Create the app-reuse connector bound to the given (optionally stubbed) deps. */
export const createAppReuseActions = (deps: AppReuseDeps) => ({
  async notify(config: NotifyNodeConfig, input: unknown, nodeName: string): Promise<{ notified: true }> {
    const fn = required(deps.notify, nodeName, 'desktop notifications');
    await fn(substituteInput(config.title ?? '', input), substituteInput(config.body ?? '', input));
    return { notified: true };
  },

  async manager(config: ManagerNodeConfig, input: unknown, nodeName: string): Promise<{ id: string; entity: string }> {
    const fn = required(deps.createManagerEntity, nodeName, 'Personal Manager');
    const title = substituteInput(config.title ?? '', input).trim();
    if (title.length === 0) throw new Error(`"${nodeName}" needs a title.`);
    const id = await fn(config.entity ?? 'task', {
      title,
      detail: config.detail ? substituteInput(config.detail, input) : undefined,
      at: config.at ? substituteInput(config.at, input) : undefined,
    });
    return { id, entity: config.entity ?? 'task' };
  },

  async browser(config: BrowserNodeConfig, input: unknown, nodeName: string): Promise<{ result: string }> {
    const fn = required(deps.runBrowserTask, nodeName, 'the embedded browser agent');
    const task = substituteInput(config.task ?? '', input).trim();
    if (task.length === 0) throw new Error(`"${nodeName}" needs a task instruction.`);
    const result = await fn(task, { url: config.url, model: config.model });
    return { result };
  },

  async conversation(config: ConversationNodeConfig, input: unknown, nodeName: string): Promise<{ reply: string }> {
    const fn = required(deps.sendConversation, nodeName, 'agent conversations');
    const message = substituteInput(config.message ?? '', input).trim();
    if (message.length === 0) throw new Error(`"${nodeName}" needs a message.`);
    const reply = await fn(message, { model: config.model });
    return { reply };
  },

  async cron(config: CronNodeConfig, input: unknown, nodeName: string): Promise<{ id: string }> {
    const fn = required(deps.createCronJob, nodeName, 'scheduled tasks');
    const cron = (config.cron ?? '').trim();
    if (cron.length === 0) throw new Error(`"${nodeName}" needs a cron expression.`);
    const prompt = substituteInput(config.prompt ?? '', input);
    const id = await fn({ cron, prompt, name: config.name });
    return { id };
  },

  async subworkflow(config: SubworkflowNodeConfig, input: unknown, nodeName: string): Promise<{ output: unknown }> {
    const fn = required(deps.runSubworkflow, nodeName, 'sub-workflows');
    const workflowId = (config.workflowId ?? '').trim();
    if (workflowId.length === 0) throw new Error(`"${nodeName}" needs a target workflow id.`);
    const output = await fn(workflowId, input);
    return { output };
  },
});

/** The shape returned by {@link createAppReuseActions} (for typing the executor map). */
export type AppReuseActions = ReturnType<typeof createAppReuseActions>;
