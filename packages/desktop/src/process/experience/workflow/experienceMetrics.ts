/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ExpBase observability metrics (Phase 4).
 *
 * Tracks how well retrieval performs over time: retrieval hit rate, suggestions
 * shown, accepted vs false matches, and capture volume. Persisted per project
 * as a single small JSON file, atomically. Injectable fs + clock for tests.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExperienceMetrics } from '../experienceTypes';

const EXPERIENCE_DIR = 'experience';
const METRICS_FILE = 'metrics.json';

/** Minimal filesystem surface used by the metrics store; injectable for tests. */
export type MetricsFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

/** Default adapter backed by Node's `fs/promises`. */
export const defaultMetricsFs: MetricsFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
};

const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

const emptyMetrics = (nowIso: string): ExperienceMetrics => ({
  retrievalsWithHits: 0,
  retrievals: 0,
  suggestionsShown: 0,
  accepted: 0,
  falseMatches: 0,
  captures: 0,
  updatedAt: nowIso,
});

/** Options for {@link createExperienceMetrics}. */
export type ExperienceMetricsOptions = {
  projectId: string;
  rootDir?: string;
  fs?: MetricsFs;
  now?: () => string;
};

/** Hit rate in `[0, 1]` (retrievals that returned at least one suggestion). */
export const hitRate = (metrics: ExperienceMetrics): number =>
  metrics.retrievals === 0 ? 0 : metrics.retrievalsWithHits / metrics.retrievals;

/** Acceptance rate in `[0, 1]` (helpful vs total feedback). */
export const acceptanceRate = (metrics: ExperienceMetrics): number => {
  const feedback = metrics.accepted + metrics.falseMatches;
  return feedback === 0 ? 0 : metrics.accepted / feedback;
};

/** Persistent per-project metrics store. */
export type IExperienceMetrics = {
  snapshot(): Promise<ExperienceMetrics>;
  recordRetrieval(hitCount: number): Promise<void>;
  recordSuggestionsShown(count: number): Promise<void>;
  recordFeedback(helped: boolean): Promise<void>;
  recordCapture(): Promise<void>;
};

/** Create a per-project metrics store. */
export const createExperienceMetrics = (options: ExperienceMetricsOptions): IExperienceMetrics => {
  const fsImpl = options.fs ?? defaultMetricsFs;
  const now = options.now ?? ((): string => new Date().toISOString());

  const resolvePath = (): string => {
    const root = options.rootDir ?? path.join(app.getPath('userData'), EXPERIENCE_DIR);
    return path.join(root, options.projectId, METRICS_FILE);
  };

  const read = async (): Promise<ExperienceMetrics> => {
    try {
      const raw = await fsImpl.readFile(resolvePath(), 'utf-8');
      return { ...emptyMetrics(now()), ...(JSON.parse(raw) as Partial<ExperienceMetrics>) };
    } catch (error) {
      if (isFileNotFound(error)) {
        return emptyMetrics(now());
      }
      throw error;
    }
  };

  const write = async (metrics: ExperienceMetrics): Promise<void> => {
    const filePath = resolvePath();
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    await fsImpl.writeFile(tmpPath, JSON.stringify(metrics, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(tmpPath, filePath);
  };

  const mutate = async (apply: (metrics: ExperienceMetrics) => void): Promise<void> => {
    const metrics = await read();
    apply(metrics);
    metrics.updatedAt = now();
    await write(metrics);
  };

  return {
    snapshot: read,
    recordRetrieval: (hitCount) =>
      mutate((metrics) => {
        metrics.retrievals += 1;
        if (hitCount > 0) {
          metrics.retrievalsWithHits += 1;
        }
      }),
    recordSuggestionsShown: (count) =>
      mutate((metrics) => {
        metrics.suggestionsShown += Math.max(0, count);
      }),
    recordFeedback: (helped) =>
      mutate((metrics) => {
        if (helped) {
          metrics.accepted += 1;
        } else {
          metrics.falseMatches += 1;
        }
      }),
    recordCapture: () =>
      mutate((metrics) => {
        metrics.captures += 1;
      }),
  };
};
