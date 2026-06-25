/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Company connector for the Automation `action.company` node.
 *
 * Lets a workflow delegate a long/complex step to a whole AI *company* (the
 * existing Agent Company feature) instead of a single `action.ai` model call.
 * It has three modes:
 *
 *  - **create** — design + persist a company from a free-text prompt
 *    (`createFromDescription`). Output: the new company id.
 *  - **goal** — hand the President a goal; it delegates across the company and
 *    returns a final summary (`conversation.run`). Output: the summary text.
 *  - **tasks** — give a task to ONE chosen role; the connector frames the goal
 *    so the President routes it to that role. Output: the summary text.
 *
 * Unattended runs have no human to click "approve", so a permission request the
 * company raises is auto-resolved (approve by default) through the engine's
 * `resolvePermission`, gated by `config.autoApprove`.
 *
 * All collaborators are injected so the connector unit-tests without Electron,
 * the network, or a live model.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { CompanyNodeConfig } from '../automationTypes';
import { substituteInput } from './artifacts';

/** A persisted company (minimal shape the connector reads). */
export type CompanyConfigLike = { companyId: string; rules?: string[] };

/** A company role node (minimal shape for resolving a `tasks` target name). */
export type RoleNodeLike = { id: string; name: string; children?: RoleNodeLike[] };

/** A built company structure (minimal shape the connector reads). */
export type CompanyStructureLike = { root: RoleNodeLike };

/** A streamed conversation event (only the arms the connector reacts to). */
export type CompanyRunEvent =
  | { type: 'run-finished'; runId: string; summary: string; status: 'done' | 'stopped' | 'error' }
  | { type: 'run-error'; runId: string; message: string }
  | { type: 'permission'; runId: string; request: { id: string } }
  | { type: string; runId?: string };

/** The conversation engine surface the connector drives. */
export type CompanyConversationLike = {
  run: (
    request: {
      structure: CompanyStructureLike;
      companyName: string;
      rules: string[];
      goal: string;
      model?: string;
      maxDelegations?: number;
    },
    onEvent: (event: CompanyRunEvent) => void
  ) => Promise<string>;
  resolvePermission: (decision: { requestId: string; approved: boolean; note?: string }) => boolean;
};

/** Injected collaborators for {@link createCompanyAction} (all from the company module). */
export type CompanyActionDeps = {
  /** Design + persist a company from a description; returns the new company id. */
  createCompany: (description: string, companyId?: string) => Promise<string>;
  /** Load a persisted company config by id. */
  loadCompany: (companyId: string) => Promise<CompanyConfigLike>;
  /** Build the elastic role tree for a company config. */
  buildStructure: (config: CompanyConfigLike) => CompanyStructureLike;
  /** Read a company's rules. */
  getRules: (companyId: string) => Promise<string[]>;
  /** The in-process boss ↔ employee conversation engine. */
  conversation: CompanyConversationLike;
};

/** Result of an `action.company` node. */
export type CompanyActionResult = {
  /** The mode that ran. */
  mode: CompanyNodeConfig['mode'];
  /** Company id involved (created or targeted). */
  companyId: string;
  /** Text output: the new id (create) or the President's summary (goal/tasks). */
  output: string;
};

/** Find a role node by id anywhere in the tree (depth-first). */
const findRole = (root: RoleNodeLike, id: string): RoleNodeLike | null => {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findRole(child, id);
    if (found) return found;
  }
  return null;
};

/**
 * Create the company action connector bound to the company module's services.
 */
export const createCompanyAction = (deps: CompanyActionDeps) => {
  /** Run a goal against a company and resolve with the President's summary. */
  const runGoal = async (
    companyId: string,
    goal: string,
    model: string | undefined,
    maxDelegations: number | undefined,
    autoApprove: boolean
  ): Promise<string> => {
    const config = await deps.loadCompany(companyId);
    const structure = deps.buildStructure(config);
    const rules = await deps.getRules(companyId).catch((): string[] => []);

    // Collected in an object so TS does not narrow these to their initial
    // literal types (closure assignments do not affect control-flow narrowing).
    const outcome: { summary: string; status: 'done' | 'stopped' | 'error'; errorMessage: string } = {
      summary: '',
      status: 'done',
      errorMessage: '',
    };

    await deps.conversation.run({ structure, companyName: companyId, rules, goal, model, maxDelegations }, (event) => {
      if (event.type === 'permission' && autoApprove) {
        const request = (event as { request?: { id: string } }).request;
        if (request)
          deps.conversation.resolvePermission({
            requestId: request.id,
            approved: true,
            note: 'Auto-approved by automation.',
          });
      } else if (event.type === 'run-finished') {
        const e = event as { summary: string; status: 'done' | 'stopped' | 'error' };
        outcome.summary = e.summary;
        outcome.status = e.status;
      } else if (event.type === 'run-error') {
        outcome.status = 'error';
        outcome.errorMessage = (event as { message: string }).message;
      }
    });

    if (outcome.status === 'error') throw new Error(outcome.errorMessage || 'The company run failed.');
    return outcome.summary;
  };

  return {
    async run(config: CompanyNodeConfig, input: unknown, nodeName: string): Promise<CompanyActionResult> {
      const autoApprove = config.autoApprove !== false;
      const model = config.model?.trim() || undefined;
      const maxDelegations =
        Number.isFinite(config.maxDelegations) && (config.maxDelegations ?? 0) > 0 ? config.maxDelegations : undefined;

      if (config.mode === 'create') {
        const description = substituteInput(config.description ?? '', input).trim();
        if (description.length === 0) throw new Error(`"${nodeName}" needs a company description to create one.`);
        const companyId = await deps.createCompany(description, config.companyId?.trim() || undefined);
        return { mode: 'create', companyId, output: companyId };
      }

      const companyId = config.companyId?.trim() ?? '';
      if (companyId.length === 0) throw new Error(`"${nodeName}" needs a target company id.`);

      if (config.mode === 'tasks') {
        const roleId = config.roleId?.trim() ?? '';
        if (roleId.length === 0) throw new Error(`"${nodeName}" needs a target role to assign the task to.`);
        const task = substituteInput(config.task ?? '', input).trim();
        if (task.length === 0) throw new Error(`"${nodeName}" needs a task description.`);

        // Resolve the role name so the goal explicitly routes the work to it.
        const config0 = await deps.loadCompany(companyId);
        const structure = deps.buildStructure(config0);
        const role = findRole(structure.root, roleId);
        const roleName = role?.name ?? roleId;
        const goal = `Assign this task specifically to "${roleName}" (role id ${roleId}). Task: ${task}`;
        const output = await runGoal(companyId, goal, model, maxDelegations, autoApprove);
        return { mode: 'tasks', companyId, output };
      }

      // mode === 'goal'
      const goal = substituteInput(config.goal ?? '', input).trim();
      if (goal.length === 0) throw new Error(`"${nodeName}" needs a goal for the President.`);
      const output = await runGoal(companyId, goal, model, maxDelegations, autoApprove);
      return { mode: 'goal', companyId, output };
    },
  };
};
