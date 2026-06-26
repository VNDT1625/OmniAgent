/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `experienceClient` — renderer-side typed client for the ExpBase surface.
 *
 * Wraps the `experience.*` IPC channels with a timeout guard so the UI never
 * hangs. Imports ONLY the renderer-safe contract (channel names + payload types)
 * from `experienceTypes` — never the bridge module, which pulls Main-process /
 * Electron dependencies.
 *
 * Renderer-only module: talks to Main exclusively through the typed bridge.
 */

import { bridge } from '@office-ai/platform';
import {
  EXPERIENCE_CHANNELS,
  type CaptureResult,
  type ExperienceEntry,
  type ExperienceEntryDraft,
  type ExperienceFilter,
  type ExperienceMetrics,
  type ExperienceQuery,
  type ExperienceResult,
  type ExperienceSuggestion,
} from '@process/experience/experienceTypes';

const TIMEOUT_MS = 30_000;

const channels = {
  record: bridge.buildProvider<ExperienceResult<CaptureResult>, { projectRoot: string; draft: ExperienceEntryDraft }>(
    EXPERIENCE_CHANNELS.record
  ),
  search: bridge.buildProvider<
    ExperienceResult<ExperienceSuggestion[]>,
    { projectRoot: string; query: ExperienceQuery; topK?: number; minScore?: number }
  >(EXPERIENCE_CHANNELS.search),
  drain: bridge.buildProvider<ExperienceResult<{ processed: number }>, { projectRoot: string }>(
    EXPERIENCE_CHANNELS.drain
  ),
  forget: bridge.buildProvider<ExperienceResult<{ archived: boolean }>, { projectRoot: string; entryId: string }>(
    EXPERIENCE_CHANNELS.forget
  ),
  feedback: bridge.buildProvider<
    ExperienceResult<{ updated: boolean }>,
    { projectRoot: string; entryId: string; helped: boolean }
  >(EXPERIENCE_CHANNELS.feedback),
  metrics: bridge.buildProvider<ExperienceResult<ExperienceMetrics>, { projectRoot: string }>(
    EXPERIENCE_CHANNELS.metrics
  ),
  list: bridge.buildProvider<ExperienceResult<ExperienceEntry[]>, { projectRoot: string; filter?: ExperienceFilter }>(
    EXPERIENCE_CHANNELS.list
  ),
};

const withTimeout = async <T>(label: string, run: () => Promise<ExperienceResult<T>>): Promise<ExperienceResult<T>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ExperienceResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `${label} timed out after ${TIMEOUT_MS}ms.` }), TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(), timeout]);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** The renderer-facing ExpBase client. */
export const experienceClient = {
  list: (projectRoot: string, filter?: ExperienceFilter): Promise<ExperienceResult<ExperienceEntry[]>> =>
    withTimeout('List experiences', () => channels.list.invoke({ projectRoot, filter })),
  search: (
    projectRoot: string,
    query: ExperienceQuery,
    topK?: number
  ): Promise<ExperienceResult<ExperienceSuggestion[]>> =>
    withTimeout('Search experiences', () => channels.search.invoke({ projectRoot, query, topK })),
  record: (projectRoot: string, draft: ExperienceEntryDraft): Promise<ExperienceResult<CaptureResult>> =>
    withTimeout('Record experience', () => channels.record.invoke({ projectRoot, draft })),
  forget: (projectRoot: string, entryId: string): Promise<ExperienceResult<{ archived: boolean }>> =>
    withTimeout('Forget experience', () => channels.forget.invoke({ projectRoot, entryId })),
  feedback: (projectRoot: string, entryId: string, helped: boolean): Promise<ExperienceResult<{ updated: boolean }>> =>
    withTimeout('Record feedback', () => channels.feedback.invoke({ projectRoot, entryId, helped })),
  metrics: (projectRoot: string): Promise<ExperienceResult<ExperienceMetrics>> =>
    withTimeout('Load metrics', () => channels.metrics.invoke({ projectRoot })),
  drain: (projectRoot: string): Promise<ExperienceResult<{ processed: number }>> =>
    withTimeout('Drain inbox', () => channels.drain.invoke({ projectRoot })),
};

export type { ExperienceEntry, ExperienceMetrics, ExperienceSuggestion } from '@process/experience/experienceTypes';
