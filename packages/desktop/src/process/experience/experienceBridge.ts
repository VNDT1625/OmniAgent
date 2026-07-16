/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for the ExpBase engine.
 *
 * Exposes the full surface to the renderer and the agent workflow:
 * record / search / drain / forget / feedback / metrics / list / verify-outcome.
 *
 * `search` first drains the `mtui exp add` inbox and forget queue, then rebuilds
 * the MTUI projection before ranking — so drafts queued by the AI-free MTUI CLI
 * become searchable on the next retrieval, closing the capture → index →
 * retrieve loop. `verifyOutcome` drives the conditional trigger: it only
 * retrieves when the agent is genuinely stuck (threshold reached or a hard
 * failure), keeping the hot path cheap.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { createDefaultEmbedder } from '@process/ide/knowledgeGraphBridge';
import { createExperienceService, createWorkflowForService, type ExperienceService } from './index';
import type { ExperienceEmbedder } from './experienceVectorIndex';
import {
  EXPERIENCE_CHANNELS,
  type CaptureResult,
  type ExperienceEntry,
  type ExperienceMetrics,
  type ExperienceResult,
  type ExperienceSuggestion,
  type ExperienceRecordRequest,
  type ExperienceSearchRequest,
  type ExperienceDrainRequest,
  type ExperienceForgetRequest,
  type ExperienceFeedbackRequest,
  type ExperienceMetricsRequest,
  type ExperienceListRequest,
} from './index';
import type { DebugEpisode, VerifyOutcomeResult } from './workflow/experienceWorkflow';

export { EXPERIENCE_CHANNELS, type ExperienceResult } from './index';

export type ExperienceVerifyOutcomeRequest = {
  projectRoot: string;
  episode: DebugEpisode;
  outcome: 'passed' | 'failed';
};

export const experienceChannels = {
  record: bridge.buildProvider<ExperienceResult<CaptureResult>, ExperienceRecordRequest>(EXPERIENCE_CHANNELS.record),
  search: bridge.buildProvider<ExperienceResult<ExperienceSuggestion[]>, ExperienceSearchRequest>(
    EXPERIENCE_CHANNELS.search
  ),
  drain: bridge.buildProvider<ExperienceResult<{ processed: number }>, ExperienceDrainRequest>(
    EXPERIENCE_CHANNELS.drain
  ),
  forget: bridge.buildProvider<ExperienceResult<{ archived: boolean }>, ExperienceForgetRequest>(
    EXPERIENCE_CHANNELS.forget
  ),
  feedback: bridge.buildProvider<ExperienceResult<{ updated: boolean }>, ExperienceFeedbackRequest>(
    EXPERIENCE_CHANNELS.feedback
  ),
  metrics: bridge.buildProvider<ExperienceResult<ExperienceMetrics>, ExperienceMetricsRequest>(
    EXPERIENCE_CHANNELS.metrics
  ),
  list: bridge.buildProvider<ExperienceResult<ExperienceEntry[]>, ExperienceListRequest>(EXPERIENCE_CHANNELS.list),
  verifyOutcome: bridge.buildProvider<ExperienceResult<VerifyOutcomeResult>, ExperienceVerifyOutcomeRequest>(
    EXPERIENCE_CHANNELS.verifyOutcome
  ),
};

// Embedding provider is resolved once (best-effort) and shared. When no provider
// is configured the engine degrades to lexical + metadata ranking.
let embedderPromise: Promise<ExperienceEmbedder | null> | null = null;
const resolveEmbedder = (): Promise<ExperienceEmbedder | null> => {
  if (!embedderPromise) {
    embedderPromise = createDefaultEmbedder().catch((): ExperienceEmbedder | null => null);
  }
  return embedderPromise;
};

const serviceCache = new Map<string, ExperienceService>();
const getService = async (projectRoot: string): Promise<ExperienceService> => {
  const existing = serviceCache.get(projectRoot);
  if (existing) {
    return existing;
  }
  const embedder = await resolveEmbedder();
  const service = createExperienceService({ projectRoot, embedder });
  serviceCache.set(projectRoot, service);
  return service;
};

// One workflow (with a persistent trigger) per project root.
const workflowCache = new Map<string, ReturnType<typeof createWorkflowForService>>();
const getWorkflow = async (projectRoot: string): Promise<ReturnType<typeof createWorkflowForService>> => {
  const existing = workflowCache.get(projectRoot);
  if (existing) {
    return existing;
  }
  const workflow = createWorkflowForService(await getService(projectRoot));
  workflowCache.set(projectRoot, workflow);
  return workflow;
};

/** Shared project-scoped service access for IPC and the IDE MCP agent plane. */
export const getExperienceServiceForRoot = getService;
export const getExperienceWorkflowForRoot = getWorkflow;

const requireRoot = (projectRoot: string | undefined): string => {
  const root = projectRoot?.trim();
  if (!root) {
    throw new Error('A projectRoot is required.');
  }
  return root;
};

const wrap = async <T>(run: () => Promise<T>): Promise<ExperienceResult<T>> => {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

export function registerExperienceBridge(): void {
  experienceChannels.record.provider((req) =>
    wrap(async () => {
      const service = await getService(requireRoot(req.projectRoot));
      return service.record(req.draft);
    })
  );

  experienceChannels.search.provider((req) =>
    wrap(async () => {
      const service = await getService(requireRoot(req.projectRoot));
      await service.drainInbox();
      return service.search(req.query, { topK: req.topK, minScore: req.minScore });
    })
  );

  experienceChannels.drain.provider((req) =>
    wrap(async () => {
      const service = await getService(requireRoot(req.projectRoot));
      const result = await service.drainInbox();
      return { processed: result.processed };
    })
  );

  experienceChannels.forget.provider((req) =>
    wrap(async () => {
      const service = await getService(requireRoot(req.projectRoot));
      return { archived: await service.forget(req.entryId) };
    })
  );

  experienceChannels.feedback.provider((req) =>
    wrap(async () => {
      const service = await getService(requireRoot(req.projectRoot));
      return { updated: await service.recordFeedback(req.entryId, req.helped) };
    })
  );

  experienceChannels.metrics.provider((req) =>
    wrap(async () => {
      const service = await getService(requireRoot(req.projectRoot));
      return service.getMetrics();
    })
  );

  experienceChannels.list.provider((req) =>
    wrap(async () => {
      const service = await getService(requireRoot(req.projectRoot));
      return service.list(req.filter);
    })
  );

  experienceChannels.verifyOutcome.provider((req) =>
    wrap(async () => {
      const workflow = await getWorkflow(requireRoot(req.projectRoot));
      const service = await getService(requireRoot(req.projectRoot));
      // Drain so freshly-added CLI experiences participate in retrieval.
      await service.drainInbox();
      return workflow.onVerifyOutcome(req.episode, service.projectId, req.outcome);
    })
  );
}
