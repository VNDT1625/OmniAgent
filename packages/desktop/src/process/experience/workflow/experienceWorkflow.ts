/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent-workflow orchestration (Phase 2).
 *
 * Ties the conditional {@link ExperienceTrigger}, the {@link ExperienceService},
 * and {@link IExperienceMetrics} together so the agent's debugging loop drives
 * ExpBase automatically:
 *
 * - `onVerifyOutcome` — track verify/test failures; when the agent is stuck
 *   (threshold reached or a hard failure) it retrieves grounded lessons.
 * - `captureSuccess` / `captureFailure` — record verified fixes, failed
 *   attempts, and self-caused mistakes.
 * - `recordFeedback` — nudge an entry's confidence up/down when a suggestion
 *   helped or misled, and track it for observability.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type {
  CaptureResult,
  ExperienceEntryDraft,
  ExperienceKind,
  ExperienceQuery,
  ExperienceSuggestion,
} from '../experienceTypes';
import { buildSignature, classifySeverity, createExperienceTrigger, type ExperienceTrigger, type TriggerDecision } from './experienceTrigger';

/** Minimal slice of the ExperienceService the workflow depends on. */
export type WorkflowService = {
  record(draft: ExperienceEntryDraft): Promise<CaptureResult>;
  search(query: ExperienceQuery, options?: { topK?: number; minScore?: number }): Promise<ExperienceSuggestion[]>;
  recordFeedback(entryId: string, helped: boolean): Promise<boolean>;
};

/** Description of a verify/test/build outcome the agent just observed. */
export type DebugEpisode = {
  command?: string;
  /** Raw error/log text (used for severity classification + the query). */
  errorText?: string;
  errorMessages?: string[];
  stackTraceDigest?: string;
  errorCategory?: string;
  files?: string[];
  frameworks?: string[];
  packages?: string[];
};

/** Result of observing a verify outcome. */
export type VerifyOutcomeResult = {
  decision: TriggerDecision;
  suggestions: ExperienceSuggestion[];
};

/** Confidence deltas applied on feedback. */
export const FEEDBACK_DELTA_HELPED = 0.05;
export const FEEDBACK_DELTA_FALSE = -0.1;

/** Dependencies for {@link createExperienceWorkflow}. */
export type ExperienceWorkflowDeps = {
  service: WorkflowService;
  trigger?: ExperienceTrigger;
};

const episodeToQuery = (episode: DebugEpisode): ExperienceQuery => ({
  symptom: episode.errorText?.trim() || episode.errorMessages?.[0] || episode.command || 'unknown failure',
  errorMessages: episode.errorMessages,
  stackTraceDigest: episode.stackTraceDigest,
  files: episode.files,
  commands: episode.command ? [episode.command] : undefined,
  frameworks: episode.frameworks,
  packages: episode.packages,
  errorCategory: episode.errorCategory,
});

const episodeSignature = (episode: DebugEpisode): string =>
  buildSignature({ command: episode.command, errorCategory: episode.errorCategory, file: episode.files?.[0] });

/** Create the agent-workflow orchestrator. */
export const createExperienceWorkflow = (deps: ExperienceWorkflowDeps) => {
  const trigger = deps.trigger ?? createExperienceTrigger();

  /**
   * Observe a verify/test outcome. On a passing run the failure streak resets.
   * On failure the trigger decides whether the agent is stuck enough to warrant
   * a retrieval; if so, lessons are fetched (the service records metrics).
   */
  const onVerifyOutcome = async (episode: DebugEpisode, projectId: string, outcome: 'passed' | 'failed'): Promise<VerifyOutcomeResult> => {
    const signature = episodeSignature(episode);
    const severity = outcome === 'failed' ? classifySeverity(episode.errorText ?? '') : 'normal';
    const decision = trigger.observe({ projectId, signature, outcome, severity });

    if (!decision.shouldRetrieve) {
      return { decision, suggestions: [] };
    }
    const suggestions = await deps.service.search(episodeToQuery(episode));
    return { decision, suggestions };
  };

  /** Capture a verified successful fix and reset the failure streak. */
  const captureSuccess = async (
    draft: Omit<ExperienceEntryDraft, 'kind'>,
    context: { projectId: string; signature?: string } = { projectId: '' }
  ): Promise<CaptureResult> => {
    const result = await deps.service.record({ ...draft, kind: 'successful_fix' });
    if (context.projectId && context.signature) {
      trigger.reset(context.projectId, context.signature);
    }
    return result;
  };

  /** Capture a failed attempt or a self-caused mistake. */
  const captureFailure = async (
    draft: Omit<ExperienceEntryDraft, 'kind'>,
    kind: Extract<ExperienceKind, 'failed_attempt' | 'agent_mistake'> = 'failed_attempt'
  ): Promise<CaptureResult> => deps.service.record({ ...draft, kind });

  /** Record whether a surfaced suggestion helped (delegates to the service). */
  const recordFeedback = (entryId: string, helped: boolean): Promise<boolean> => deps.service.recordFeedback(entryId, helped);

  return { onVerifyOutcome, captureSuccess, captureFailure, recordFeedback, trigger };
};
