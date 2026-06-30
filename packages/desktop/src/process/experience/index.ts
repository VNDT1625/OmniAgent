/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ExpBase engine barrel + high-level service.
 *
 * {@link createExperienceService} wires the store, capture, retrieval, MTUI
 * projection, graph relations, and metrics together for a single project. It is
 * the entry point used by the IPC bridge and the agent-workflow orchestrator.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

export * from './experienceTypes';
export { createExperienceStore, type IExperienceStore, type ExperienceStoreFs } from './experienceStore';
export { createExperienceCapture, normalizeDraft, mergeEntries, lexicalJaccard } from './experienceCapture';
export { createExperienceRetrieval, rankExperiences, buildQueryText, computeContextMatch } from './experienceRetrieval';
export {
  buildProjection,
  writeProjection,
  readProjection,
  readInbox,
  appendInbox,
  clearInbox,
  toProjectionEntry,
  MTUI_EXP_DIR,
} from './experienceProjection';
export { normalizeVector, cosineSimilarity, type ExperienceEmbedder } from './experienceVectorIndex';
export {
  createExperienceTrigger,
  buildSignature,
  classifySeverity,
  type ExperienceTrigger,
  type TriggerDecision,
  type TriggerSignal,
} from './workflow/experienceTrigger';
export { inferRelations, recomputeAllRelations, enrichSuggestions } from './workflow/experienceGraph';
export {
  createExperienceMetrics,
  hitRate,
  acceptanceRate,
  type IExperienceMetrics,
  type MetricsFs,
} from './workflow/experienceMetrics';
export {
  createExperienceWorkflow,
  FEEDBACK_DELTA_HELPED,
  FEEDBACK_DELTA_FALSE,
  type DebugEpisode,
  type VerifyOutcomeResult,
  type ExperienceWorkflowDeps,
} from './workflow/experienceWorkflow';

import { clampConfidence } from './experienceText';
import { createExperienceCapture } from './experienceCapture';
import { createExperienceRetrieval } from './experienceRetrieval';
import {
  buildProjection,
  clearFeedback,
  clearForget,
  clearInbox,
  readFeedback,
  readForget,
  readInbox,
  readProjection,
  writeProjection,
  type ProjectionFs,
} from './experienceProjection';
import { createExperienceStore, type IExperienceStore } from './experienceStore';
import type { ExperienceEmbedder } from './experienceVectorIndex';
import type {
  CaptureResult,
  ExperienceEntry,
  ExperienceFilter,
  ExperienceMetrics,
  ExperienceQuery,
  ExperienceEntryDraft,
  ExperienceSuggestion,
} from './experienceTypes';
import { recomputeAllRelations, enrichSuggestions } from './workflow/experienceGraph';
import { createExperienceMetrics, type IExperienceMetrics } from './workflow/experienceMetrics';
import { createExperienceTrigger, type ExperienceTrigger } from './workflow/experienceTrigger';
import { createExperienceWorkflow, FEEDBACK_DELTA_FALSE, FEEDBACK_DELTA_HELPED } from './workflow/experienceWorkflow';

/** Stable, path-separator-free project id derived from a workspace root (FNV-1a). */
export const projectIdFromRoot = (projectRoot: string): string => {
  const normalized = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `proj_${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

/** Options for {@link createExperienceService}. */
export type ExperienceServiceOptions = {
  /** Absolute workspace root; MTUI projection/inbox live under `<root>/.mtui/exp/`. */
  projectRoot: string;
  /** Stable project id; defaults to {@link projectIdFromRoot}. */
  projectId?: string;
  /** Store instance; defaults to a `userData`-backed file store. */
  store?: IExperienceStore;
  /** Embedding provider; absent means lexical + metadata ranking only. */
  embedder?: ExperienceEmbedder | null;
  /** Metrics store; absent means a default `userData`-backed one is created. */
  metrics?: IExperienceMetrics | null;
  /** Conditional retrieval trigger shared by the workflow. */
  trigger?: ExperienceTrigger;
  /** ISO clock for capture timestamps. */
  now?: () => string;
  /** Epoch-ms clock for retrieval recency. */
  clock?: () => number;
  /** Filesystem for the MTUI projection/inbox files. Injectable for tests. */
  projectionFs?: ProjectionFs;
};

/** High-level facade over the ExpBase engine for one project. */
export type ExperienceService = {
  readonly projectId: string;
  /** Capture one experience and refresh the MTUI projection. */
  record(draft: ExperienceEntryDraft): Promise<CaptureResult>;
  /** Retrieve advisory suggestions (graph-enriched) for a current problem. */
  search(query: ExperienceQuery, options?: { topK?: number; minScore?: number }): Promise<ExperienceSuggestion[]>;
  /** Drain `mtui exp add` drafts + forget queue, capture each, refresh projection. */
  drainInbox(): Promise<{ processed: number; results: CaptureResult[] }>;
  /** Rebuild and persist the MTUI projection + graph relations from the store. */
  rebuildProjection(): Promise<void>;
  /** Archive an entry (kept for audit) and refresh the projection. */
  forget(entryId: string): Promise<boolean>;
  /** Fetch a single entry by id. */
  get(entryId: string): Promise<ExperienceEntry | null>;
  /** List entries (optionally filtered) for inspection/UI. */
  list(filter?: ExperienceFilter): Promise<ExperienceEntry[]>;
  /** Adjust an entry's confidence by `delta` (clamped to [0,1]). */
  updateConfidence(entryId: string, delta: number): Promise<boolean>;
  /** Record whether a surfaced suggestion helped, adjusting confidence + metrics. */
  recordFeedback(entryId: string, helped: boolean): Promise<boolean>;
  /** Current observability metrics snapshot. */
  getMetrics(): Promise<ExperienceMetrics>;
};

const relationKey = (rel: { type: string; targetId: string }): string => `${rel.type}\u0000${rel.targetId}`;

const relationsEqual = (a: ExperienceEntry['relations'], b: ExperienceEntry['relations']): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  const setA = new Set(a.map(relationKey));
  return b.every((rel) => setA.has(relationKey(rel)));
};

/** Best-effort metrics wrapper — a metrics failure never breaks capture/retrieval. */
const safeMetric = async (run: () => Promise<void>): Promise<void> => {
  try {
    await run();
  } catch {
    // ignore
  }
};

/** Create the per-project ExpBase service. */
export const createExperienceService = (options: ExperienceServiceOptions): ExperienceService => {
  const projectId = options.projectId ?? projectIdFromRoot(options.projectRoot);
  const store = options.store ?? createExperienceStore();
  const now = options.now ?? ((): string => new Date().toISOString());
  const metrics = options.metrics ?? createExperienceMetrics({ projectId, now });
  const capture = createExperienceCapture({ store, embedder: options.embedder, now: options.now });
  const retrieval = createExperienceRetrieval({ embedder: options.embedder, now: options.clock });

  const rebuildProjection = async (recomputeRelations = true): Promise<void> => {
    const entries = await store.searchMetadata({ projectId });
    if (recomputeRelations) {
      // Recompute typed graph relations and persist only the entries that changed.
      const relById = recomputeAllRelations(entries);
      const changed = entries.filter((entry) => {
        const next = relById.get(entry.id) ?? [];
        if (relationsEqual(entry.relations ?? [], next)) {
          return false;
        }
        entry.relations = next;
        return true;
      });
      await Promise.all(changed.map((entry) => store.update(entry.id, { relations: entry.relations })));
    }
    const projection = buildProjection(entries, {
      providerId: options.embedder?.providerId,
      model: options.embedder?.model,
    });
    await writeProjection(options.projectRoot, projection, options.projectionFs);
  };

  const rebuildProjectionPublic: ExperienceService['rebuildProjection'] = () => rebuildProjection(true);

  const record: ExperienceService['record'] = async (draft) => {
    const result = await capture.capture({ ...draft, projectId });
    await safeMetric(() => metrics.recordCapture());
    await rebuildProjection();
    return result;
  };

  const search: ExperienceService['search'] = async (query, searchOptions = {}) => {
    const projection = await readProjection(options.projectRoot, options.projectionFs);
    const entries = projection
      ? projection.entries
      : buildProjection(await store.searchMetadata({ projectId })).entries;
    const ranked = await retrieval.retrieve(
      { ...query, projectId: query.projectId ?? projectId },
      entries,
      searchOptions
    );
    const sourceById = new Map(
      entries.map(
        (entry) =>
          [
            entry.id,
            {
              id: entry.id,
              kind: entry.kind,
              status: entry.status,
              lesson: entry.lesson,
              relations: entry.relations ?? [],
            },
          ] as const
      )
    );
    const enriched = enrichSuggestions(ranked, sourceById);
    await safeMetric(() => metrics.recordRetrieval(enriched.length));
    if (enriched.length > 0) {
      await safeMetric(() => metrics.recordSuggestionsShown(enriched.length));
    }
    return enriched;
  };

  const drainInbox: ExperienceService['drainInbox'] = async () => {
    const items = await readInbox(options.projectRoot, options.projectionFs);
    const results: CaptureResult[] = [];
    for (const item of items) {
      try {
        results.push(await capture.capture({ ...item.draft, projectId }));
        await safeMetric(() => metrics.recordCapture());
      } catch {
        // Skip malformed drafts; continue draining the rest.
      }
    }
    await clearInbox(options.projectRoot, options.projectionFs);

    // Process the forget queue written by `mtui exp forget`.
    const forgetIds = await readForget(options.projectRoot, options.projectionFs);
    let forgotten = 0;
    for (const entryId of forgetIds) {
      try {
        const existing = await store.get(entryId);
        if (existing) {
          await store.update(entryId, { status: 'archived', updatedAt: now() });
          forgotten += 1;
        }
      } catch {
        // Skip ids that cannot be archived; continue.
      }
    }
    await clearForget(options.projectRoot, options.projectionFs);

    // Process the feedback queue written by `mtui exp feedback`.
    const feedbackItems = await readFeedback(options.projectRoot, options.projectionFs);
    let feedbackApplied = 0;
    for (const item of feedbackItems) {
      try {
        const existing = await store.get(item.id);
        if (existing) {
          const delta = item.helped ? FEEDBACK_DELTA_HELPED : FEEDBACK_DELTA_FALSE;
          await store.update(item.id, {
            confidence: clampConfidence(existing.confidence + delta, existing.confidence),
            updatedAt: now(),
          });
          await safeMetric(() => metrics.recordFeedback(item.helped));
          feedbackApplied += 1;
        }
      } catch {
        // Skip ids that cannot be updated; continue.
      }
    }
    await clearFeedback(options.projectRoot, options.projectionFs);

    if (results.length > 0 || forgotten > 0 || feedbackApplied > 0) {
      await rebuildProjection();
    }
    return { processed: items.length, results };
  };

  const forget: ExperienceService['forget'] = async (entryId) => {
    const entry = await store.get(entryId);
    if (!entry) {
      return false;
    }
    await store.update(entryId, { status: 'archived', updatedAt: now() });
    await rebuildProjection(false);
    return true;
  };

  const updateConfidence: ExperienceService['updateConfidence'] = async (entryId, delta) => {
    const entry = await store.get(entryId);
    if (!entry) {
      return false;
    }
    await store.update(entryId, {
      confidence: clampConfidence(entry.confidence + delta, entry.confidence),
      updatedAt: now(),
    });
    await rebuildProjection(false);
    return true;
  };

  const recordFeedback: ExperienceService['recordFeedback'] = async (entryId, helped) => {
    const updated = await updateConfidence(entryId, helped ? FEEDBACK_DELTA_HELPED : FEEDBACK_DELTA_FALSE);
    await safeMetric(() => metrics.recordFeedback(helped));
    return updated;
  };

  return {
    projectId,
    record,
    search,
    drainInbox,
    rebuildProjection: rebuildProjectionPublic,
    forget,
    get: (entryId) => store.get(entryId),
    list: (filter) => store.searchMetadata({ ...filter, projectId }),
    updateConfidence,
    recordFeedback,
    getMetrics: () => metrics.snapshot(),
  };
};

/** Build the agent-workflow orchestrator bound to a service. */
export const createWorkflowForService = (
  service: ExperienceService,
  trigger?: ExperienceTrigger
): ReturnType<typeof createExperienceWorkflow> =>
  createExperienceWorkflow({ service, trigger: trigger ?? createExperienceTrigger() });
