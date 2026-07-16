/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Delegation planner — the "brain" each role consults to decide what to do this
 * step (Requirement 2). Given the role's soul (which carries its workflow), the
 * company rules, the incoming task, and the role's **direct children**, it asks
 * the model for ONE decision: delegate to direct reports, execute the task
 * itself, request an approval, request a test, request a permission, or finish.
 *
 * The protocol is a single fenced JSON object (provider-agnostic, like the
 * Browser web-agent runner) so it works on any OpenAI-compatible model. The
 * planner enforces the core invariant of a real company: **a role may only
 * delegate to its immediate children** — any directive naming a non-direct child
 * is dropped (Requirement 2.1 / 2.4).
 *
 * Process boundary: Renderer module. No Node.js APIs — the model call is injected.
 */

import type { Directive, PlannerDecision } from './pipelineTypes';

/** A minimal chat-completion call (injected). Returns the raw assistant text. */
export type PlannerChat = (params: {
  model?: string;
  messages: Array<{ role: string; content: string }>;
  signal?: AbortSignal;
}) => Promise<string>;

/** A direct child the role may delegate to. */
export type DirectChild = {
  /** Child role node id. */
  id: string;
  /** Child display name. */
  name: string;
  /** Child role kind. */
  role: string;
  /** Child responsibilities (if any). */
  responsibilities?: string;
};

/** Input to {@link planRoleDecision}. */
export type PlanInput = {
  /** Display name of the deciding role. */
  roleName: string;
  /** The role's soul (identity + workflow). */
  soul: string;
  /** The role's accumulated memory (optional). */
  memory?: string;
  /** Company-wide rules. */
  rules: string[];
  /** The task this role was handed by its superior (or the top-level goal). */
  incoming: string;
  /** The role's DIRECT children (only these may be delegated to). */
  directChildren: DirectChild[];
  /** Model id to run the planner with (optional). */
  model?: string;
  /** Cancellation signal. */
  signal?: AbortSignal;
};

/** Extract the first JSON object from a model reply (fenced or bare). */
const extractJson = (reply: string): string | null => {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) return fenced[1].trim();
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start !== -1 && end > start) return reply.slice(start, end + 1).trim();
  return null;
};

/** Coerce an unknown into a trimmed non-empty string, or undefined. */
const asText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Parse + validate a model reply into a {@link PlannerDecision}.
 *
 * Exported for unit testing the parsing/guard logic without a live model.
 * `directChildIds` is the set of immediate children; any `delegate` directive
 * naming an id outside it is dropped. A delegate decision with no valid
 * directives degrades to `finish` so the run never stalls on a bad plan.
 */
export const parsePlannerDecision = (reply: string, directChildIds: Set<string>): PlannerDecision => {
  const json = extractJson(reply);
  if (!json) return { mode: 'finish', result: reply.trim() || 'No decision produced.' };

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { mode: 'finish', result: reply.trim() || 'No decision produced.' };
  }
  if (!raw || typeof raw !== 'object') {
    return { mode: 'finish', result: 'No decision produced.' };
  }
  const obj = raw as Record<string, unknown>;
  const mode = asText(obj.mode);

  switch (mode) {
    case 'delegate': {
      const rawList = Array.isArray(obj.directives) ? obj.directives : [];
      const directives: Directive[] = [];
      for (const entry of rawList) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const childId = asText(e.childId);
        const task = asText(e.task);
        // Guard: only immediate children may be delegated to (no level-skipping).
        if (childId && task && directChildIds.has(childId)) {
          // dependsOn must also reference immediate children (drop the rest);
          // self-references are removed to avoid a trivial deadlock.
          const dependsOn = Array.isArray(e.dependsOn)
            ? e.dependsOn.map(asText).filter((d): d is string => Boolean(d) && d !== childId && directChildIds.has(d))
            : [];
          directives.push({ childId, task, ...(dependsOn.length > 0 ? { dependsOn } : {}) });
        }
      }
      if (directives.length === 0) {
        return { mode: 'finish', result: 'Nothing valid to delegate.' };
      }
      return { mode: 'delegate', directives };
    }
    case 'execute': {
      const task = asText(obj.task) ?? '';
      return { mode: 'execute', task };
    }
    case 'request_approval': {
      const artifact = asText(obj.artifact) ?? '';
      const summary = asText(obj.summary) ?? 'Requesting approval.';
      return { mode: 'request_approval', artifact, summary };
    }
    case 'request_test': {
      const scenarioName = asText(obj.scenarioName) ?? 'Test';
      const steps = Array.isArray(obj.steps) ? obj.steps.map(asText).filter((s): s is string => Boolean(s)) : [];
      return { mode: 'request_test', scenarioName, steps };
    }
    case 'request_permission': {
      const action = asText(obj.action) ?? '';
      const reason = asText(obj.reason);
      return { mode: 'request_permission', action, reason };
    }
    case 'finish':
    default: {
      const result = asText(obj.result) ?? reply.trim();
      return { mode: 'finish', result };
    }
  }
};

/** Build the planner system prompt teaching the JSON decision protocol. */
const buildSystemPrompt = (input: PlanInput): string => {
  const ruleBlock =
    input.rules.length > 0
      ? `\n\nCompany rules (must always follow):\n${input.rules.map((r) => `- ${r}`).join('\n')}`
      : '';
  const childrenBlock =
    input.directChildren.length > 0
      ? input.directChildren
          .map((c) => `- id: ${c.id} — ${c.name} (${c.role}${c.responsibilities ? `, ${c.responsibilities}` : ''})`)
          .join('\n')
      : '- (none — you have no direct reports; you must execute the task yourself)';

  return `You are "${input.roleName}". You MUST act according to your SOUL, which defines your binding role and workflow. Follow it 100% of the time and stay strictly within your role.

SOUL:
${input.soul}
${input.memory ? `\nYOUR MEMORY:\n${input.memory}` : ''}${ruleBlock}

Your DIRECT reports (you may delegate ONLY to these — never to anyone else, never skip a level):
${childrenBlock}

Decide your SINGLE next action and reply with EXACTLY ONE JSON object in a \`\`\`json fence, nothing else:
- {"mode":"delegate","directives":[{"childId":"<one of your direct report ids>","task":"...","dependsOn":["<other direct report id>"]}]}  → hand work down ("dependsOn" is optional: list the ids of direct reports whose results must finish FIRST — e.g. QA dependsOn Backend & Frontend; Backend & Frontend dependsOn Architecture. Omit dependsOn for work that can start immediately / run in parallel.)
- {"mode":"execute","task":"..."}                       → do this task yourself, for real, in your workspace
- {"mode":"request_approval","artifact":"<the document/result>","summary":"..."}  → pause for your superior to approve
- {"mode":"request_test","scenarioName":"...","steps":["goto ...","assertText ..."]}  → run an automated test
- {"mode":"request_permission","action":"...","reason":"..."}  → ask permission for a sensitive action
- {"mode":"finish","result":"..."}                      → you are done; give your result to your superior

Rules (MANDATORY — this is a binding company process):
- If you have direct reports, you MUST delegate to them (you lead and coordinate — you do not do their hands-on work yourself). Delegate ONLY to your listed direct reports; never skip a level. If you have NO direct reports, you must "execute" the task yourself or "finish".
- You MUST follow your SOUL's workflow exactly to choose the action — do not skip steps or act outside your role. Be decisive — one action per reply.`;
};

/**
 * Ask the model for this role's next action.
 *
 * @param input The deciding role's context.
 * @param chat  Injected model call.
 */
export const planRoleDecision = async (input: PlanInput, chat: PlannerChat): Promise<PlannerDecision> => {
  const directChildIds = new Set(input.directChildren.map((c) => c.id));
  const reply = await chat({
    model: input.model,
    signal: input.signal,
    messages: [
      { role: 'system', content: buildSystemPrompt(input) },
      { role: 'user', content: `Task handed to you: ${input.incoming}` },
    ],
  });
  return parsePlannerDecision(reply, directChildIds);
};
