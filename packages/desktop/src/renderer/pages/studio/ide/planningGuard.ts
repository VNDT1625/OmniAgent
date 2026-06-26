/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-side MTUI runtime preflight used by conversation send boxes. This
 * enforces policy and plan-task ownership before a message reaches the agent.
 */

import { ideClient } from './ideClient';
import type { SpecTaskRunbook } from './ideClient';

const PLANNING_PREFIX = 'studio.ide.planning.';
const EXECUTE_PLAN_RE = /^\/execute\s+@(\S+)(?:\s+(\S+))?(?:\s+(.+))?$/i;

const isPlanningEnabled = (rootPath: string): boolean => {
  try {
    return localStorage.getItem(PLANNING_PREFIX + rootPath) === '1';
  } catch {
    return false;
  }
};

const slugFromExecuteTarget = (target: string): string | undefined => {
  if (target.toLowerCase() === 'plan') return undefined;
  const normalized = target.replace(/\\/g, '/').replace(/\/+$/g, '');
  const marker = '/.aionui/specs/';
  const markerIndex = normalized.toLowerCase().lastIndexOf(marker);
  if (markerIndex >= 0) {
    return normalized.slice(markerIndex + marker.length).split('/')[0] || undefined;
  }
  const relativePrefix = '.aionui/specs/';
  if (normalized.toLowerCase().startsWith(relativePrefix)) {
    return normalized.slice(relativePrefix.length).split('/')[0] || undefined;
  }
  return normalized.split('/').pop() || undefined;
};

export class MtuiRuntimePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MtuiRuntimePreflightError';
  }
}

const findClaimedTask = (
  runbook: SpecTaskRunbook,
  selector: string | undefined
): SpecTaskRunbook['tasks'][number] | null => {
  const claimed =
    (selector
      ? runbook.tasks.find(
          (task) =>
            task.id.toLowerCase() === selector.toLowerCase() ||
            task.title.toLowerCase().startsWith(`${selector.toLowerCase()} `) ||
            task.title.toLowerCase() === selector.toLowerCase()
        )
      : null) ??
    runbook.tasks.find((task) => task.id === runbook.activeTaskId) ??
    runbook.tasks.find((task) => task.status === 'in_progress');
  return claimed ?? null;
};

export const buildPlanningGuard = async (rootPath: string, userMessage: string): Promise<string> => {
  if (!rootPath) {
    return userMessage;
  }

  const executeMatch = userMessage.trim().match(EXECUTE_PLAN_RE);
  if (!executeMatch) {
    // Ordinary turn (no /execute): skip the plan-claim/policy preflight and send
    // the message untouched. The tool-preference rule is NOT appended per turn
    // anymore — it is bound once into the session memory when the IDE chat tab
    // opens (see useIdeChat), so the agent recalls it on demand via ide_memory_recall
    // instead of every message carrying a noisy reminder.
    return userMessage;
  }

  let commandRunbook: SpecTaskRunbook | null = null;
  if (executeMatch) {
    const target = executeMatch[1];
    const selector = executeMatch[2];
    const slug = slugFromExecuteTarget(target);

    // Gate execution on the spec lifecycle: a spec must have its requirements,
    // design, and tasks phases approved (i.e. be in the `execution` phase)
    // before any task may be claimed. This is what makes Planning Mode a real
    // Kiro-style gated workflow instead of a loose set of files.
    const statusResult = await ideClient.specStatus(rootPath).catch((): null => null);
    const status = statusResult?.ok ? statusResult.data : null;
    if (status?.exists && status.phase && status.phase !== 'execution' && status.phase !== 'complete') {
      throw new MtuiRuntimePreflightError(
        `Spec "${status.slug}" is in the "${status.phase}" phase. Approve the requirements, design, and tasks gates before running /execute.`
      );
    }

    const claimResult = await ideClient.specTaskClaim(rootPath, slug, selector, 'chat-agent').catch((): null => null);
    if (claimResult?.ok) {
      commandRunbook = claimResult.data;
      const claimed = findClaimedTask(claimResult.data, selector);
      if (!claimed) {
        throw new MtuiRuntimePreflightError('No executable planning task is available for the selected spec.');
      }
    } else {
      const claimError = claimResult && 'error' in claimResult ? claimResult.error : '';
      throw new MtuiRuntimePreflightError(
        claimError ? `Could not claim a planning task: ${claimError}` : 'Could not claim a planning task.'
      );
    }
  }

  const gitStatusResult = await ideClient.gitStatus(rootPath).catch((): null => null);
  const changedPaths = gitStatusResult?.ok ? gitStatusResult.data.map((change) => change.path) : [];
  if (changedPaths.length > 0) {
    const policyResult = await ideClient.mtuiPolicyCheck(rootPath, changedPaths).catch((): null => null);
    const policy = policyResult?.ok ? policyResult.data : null;
    const violations = policy?.violations ?? [];
    const violationCount = policy?.violationCount ?? violations.length;
    if (violationCount > 0) {
      const shown = violations.slice(0, 3);
      const sample = shown.map((violation) => violation.path).join(', ');
      const suffix = violationCount > shown.length ? `, and ${violationCount - shown.length} more` : '';
      const samplePart = sample ? `: ${sample}${suffix}` : '';
      throw new MtuiRuntimePreflightError(
        `Strict MTUI Mode blocked this send: ${violationCount} unowned changed file(s)${samplePart}. Run mtui --json policy status, or session-start for user-owned pre-existing changes.`
      );
    }
  }

  if (isPlanningEnabled(rootPath)) {
    const statusResult = await ideClient.specStatus(rootPath).catch((): null => null);
    const status = statusResult?.ok ? statusResult.data : null;
    const _tasksResult = commandRunbook
      ? null
      : await ideClient.specTaskList(rootPath, status?.slug ?? undefined).catch((): null => null);
    const missingFiles = status
      ? Object.entries(status.files)
          .filter(([, exists]) => !exists)
          .map(([file]) => file)
      : ['requirements.md', 'design.md', 'tasks.md', 'verification.md'];

    if (missingFiles.length > 0 && executeMatch) {
      throw new MtuiRuntimePreflightError(`Planning spec is incomplete: missing ${missingFiles.join(', ')}.`);
    }
  }

  return userMessage;
};
