/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Automation workflow scheduler — the real cron runner that makes
 * `trigger.schedule` nodes actually fire on time.
 *
 * On startup it scans all enabled workflows whose first node is a
 * `trigger.schedule`, arms a `croner` job for each one, and re-arms whenever
 * the workflow list changes (via the store's `onChange` hook). When a job fires
 * it calls the injected `runWorkflow` function (the bridge's run handler) so the
 * run log streams to the renderer exactly as if the user had pressed "Run".
 *
 * Supports both `everyMinutes` (converted to a `*\/n * * * *` expression) and
 * a raw `cron` expression. Invalid expressions are logged and skipped — they
 * never crash the scheduler.
 *
 * The `armCron` function is injectable so tests can fire jobs deterministically
 * without real timers.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { Cron } from 'croner';
import type { IAutomationStore } from './automationStore';
import type { Workflow } from './automationTypes';

/** A handle to a running cron job (stop it to disarm). */
type Armed = { stop: () => void };

/** Injectable cron-arming function (default: real `croner` Cron). */
export type ArmCronFn = (expression: string, onTick: () => void) => Armed;

/** Injectable dependencies for {@link createAutomationScheduler}. */
export type AutomationSchedulerDeps = {
  /** The workflow store to scan and subscribe to. */
  store: IAutomationStore;
  /** Called when a scheduled workflow fires; should run the workflow. */
  runWorkflow: (workflowId: string) => Promise<void>;
  /** Override the cron-arming implementation (tests). */
  armCron?: ArmCronFn;
};

/** Public contract of the scheduler. */
export type IAutomationScheduler = {
  /** Arm all enabled scheduled workflows and subscribe to store changes. */
  start(): Promise<void>;
  /** Disarm all running jobs and unsubscribe. */
  stop(): void;
};

/** Convert `everyMinutes` to a standard cron expression. */
const everyMinutesToCron = (minutes: number): string => {
  const n = Math.max(1, Math.floor(minutes));
  return n === 1 ? '* * * * *' : `*/${n} * * * *`;
};

/** Extract the cron expression from a `trigger.schedule` node config. */
const extractExpression = (workflow: Workflow): string | null => {
  const trigger = workflow.nodes[0];
  if (!trigger || trigger.kind !== 'trigger.schedule') return null;
  const config = trigger.config as Record<string, unknown>;
  if (typeof config.cron === 'string' && config.cron.trim().length > 0) return config.cron.trim();
  if (typeof config.everyMinutes === 'number' && config.everyMinutes > 0)
    return everyMinutesToCron(config.everyMinutes);
  return null;
};

const defaultArmCron: ArmCronFn = (expression, onTick) => {
  const job = new Cron(expression, {}, onTick);
  return { stop: () => job.stop() };
};

/**
 * Create the automation scheduler. Call {@link IAutomationScheduler.start} once
 * during Main-process bootstrap (after the bridge is registered).
 */
export const createAutomationScheduler = (deps: AutomationSchedulerDeps): IAutomationScheduler => {
  const armCron = deps.armCron ?? defaultArmCron;
  const armed = new Map<string, Armed>();
  let unsubscribe: (() => void) | null = null;

  /** Disarm a single workflow's job (if any). */
  const disarm = (workflowId: string): void => {
    const job = armed.get(workflowId);
    if (job) {
      try {
        job.stop();
      } catch {
        // ignore
      }
      armed.delete(workflowId);
    }
  };

  /** Arm a workflow if it is enabled and has a valid schedule trigger. */
  const arm = (workflow: Workflow): void => {
    disarm(workflow.id);
    if (!workflow.enabled) return;
    const expression = extractExpression(workflow);
    if (!expression) return;
    try {
      const job = armCron(expression, () => {
        void deps.runWorkflow(workflow.id).catch((error: unknown) => {
          console.error(`[AutomationScheduler] workflow "${workflow.id}" run failed:`, error);
        });
      });
      armed.set(workflow.id, job);
      console.log(`[AutomationScheduler] armed "${workflow.name}" (${expression})`);
    } catch (error) {
      console.error(
        `[AutomationScheduler] invalid cron expression "${expression}" for workflow "${workflow.id}":`,
        error
      );
    }
  };

  /** Re-arm all workflows from the current store snapshot. */
  const rearm = (workflows: Workflow[]): void => {
    // Disarm any workflow that is no longer in the list.
    const ids = new Set(workflows.map((w) => w.id));
    for (const id of armed.keys()) {
      if (!ids.has(id)) disarm(id);
    }
    for (const workflow of workflows) arm(workflow);
  };

  return {
    async start() {
      const workflows = await deps.store.list();
      rearm(workflows);
      // Re-arm whenever the store changes (workflow created/updated/deleted).
      unsubscribe = deps.store.onChange((updated) => rearm(updated));
    },

    stop() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      for (const id of armed.keys()) disarm(id);
    },
  };
};
