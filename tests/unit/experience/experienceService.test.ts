/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * End-to-end tests for the ExpBase service facade: record -> projection ->
 * search -> inbox drain -> forget, all on in-memory filesystems.
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExperienceService, projectIdFromRoot } from '@/process/experience';
import { createExperienceMetrics } from '@/process/experience/workflow/experienceMetrics';
import { appendInbox, appendFeedback, MTUI_EXP_DIR } from '@/process/experience/experienceProjection';
import { createExperienceStore } from '@/process/experience/experienceStore';
import type { ExperienceEntryDraft } from '@/process/experience/experienceTypes';
import { createMemFs } from './memFs';

const ROOT = path.join('svc-root');

const draft = (overrides: Partial<ExperienceEntryDraft> = {}): ExperienceEntryDraft => ({
  projectId: 'ignored-overridden-by-service',
  kind: 'successful_fix',
  symptoms: { summary: 'webpack HMR stops after edit', errorMessages: ['[HMR] Cannot apply update'] },
  context: {
    files: ['webpack.config.js'],
    commands: ['bun run dev'],
    frameworks: ['webpack'],
    packages: ['webpack'],
    errorCategory: 'build',
  },
  rootCause: 'stale cache directory',
  fix: { summary: 'clear .cache and restart', steps: ['rm -rf node_modules/.cache'], changedFiles: [] },
  lesson: 'clear webpack cache when HMR breaks',
  verification: { commands: [{ command: 'bun run dev', outcome: 'passed' }], confidenceEvidence: ['HMR works'] },
  tags: ['webpack', 'hmr'],
  confidence: 0.75,
  ...overrides,
});

const makeService = () => {
  const storeFs = createMemFs();
  const projectionFs = createMemFs();
  const metricsFs = createMemFs();
  const projectId = projectIdFromRoot(ROOT);
  const service = createExperienceService({
    projectRoot: ROOT,
    projectId,
    store: createExperienceStore({ rootDir: path.join(ROOT, 'store'), fs: storeFs }),
    metrics: createExperienceMetrics({
      projectId,
      rootDir: path.join(ROOT, 'metrics'),
      fs: metricsFs,
      now: () => '2026-06-09T00:00:00.000Z',
    }),
    projectionFs,
    now: () => '2026-06-09T00:00:00.000Z',
  });
  return { service, projectionFs };
};

describe('projectIdFromRoot', () => {
  it('is stable, separator-free, and case/path-insensitive', () => {
    const a = projectIdFromRoot('C:\\Repo\\App\\');
    const b = projectIdFromRoot('c:/repo/app');
    expect(a).toBe(b);
    expect(a).toMatch(/^proj_[0-9a-f]{8}$/);
  });
});

describe('createExperienceService', () => {
  it('records an experience, writes the MTUI projection, and finds it on search', async () => {
    const { service, projectionFs } = makeService();

    const result = await service.record(draft());
    expect(result.action).toBe('created');
    expect(result.entry.projectId).toBe(service.projectId);
    expect(projectionFs.files.has(path.join(ROOT, MTUI_EXP_DIR, 'index.json'))).toBe(true);

    const suggestions = await service.search({
      symptom: 'HMR stopped working after I edited a file',
      frameworks: ['webpack'],
      commands: ['bun run dev'],
      files: ['webpack.config.js'],
      errorCategory: 'build',
    });
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].lesson).toContain('clear webpack cache');
    expect(suggestions[0].suggestedChecks.length).toBeGreaterThan(0);
  });

  it('drains queued inbox drafts and rebuilds the projection', async () => {
    const { service, projectionFs } = makeService();
    await appendInbox(ROOT, { receivedAt: '2026-06-09T00:00:00.000Z', draft: draft() }, projectionFs);

    const drained = await service.drainInbox();
    expect(drained.processed).toBe(1);
    expect(drained.results[0].action).toBe('created');

    const suggestions = await service.search({ symptom: 'webpack HMR cannot apply update', frameworks: ['webpack'] });
    expect(suggestions.length).toBeGreaterThan(0);

    // Inbox is cleared after draining.
    const second = await service.drainInbox();
    expect(second.processed).toBe(0);
  });

  it('forget archives an entry so it no longer surfaces', async () => {
    const { service } = makeService();
    const created = await service.record(draft());

    expect(await service.forget(created.entry.id)).toBe(true);
    const got = await service.get(created.entry.id);
    expect(got?.status).toBe('archived');

    const suggestions = await service.search({ symptom: 'webpack HMR cannot apply update', frameworks: ['webpack'] });
    expect(suggestions).toEqual([]);
  });

  it('drains the feedback queue and adjusts confidence', async () => {
    const { service, projectionFs } = makeService();
    const created = await service.record(draft({ confidence: 0.5 }));
    await appendFeedback(ROOT, { id: created.entry.id, helped: true }, projectionFs);

    await service.drainInbox();

    const after = await service.get(created.entry.id);
    expect(after?.confidence).toBeCloseTo(0.55, 6);
    const metrics = await service.getMetrics();
    expect(metrics.accepted).toBe(1);
  });

  it('forget returns false for an unknown entry', async () => {
    const { service } = makeService();
    expect(await service.forget('ghost')).toBe(false);
  });

  it('tracks metrics for captures, retrievals, and feedback', async () => {
    const { service } = makeService();
    const created = await service.record(draft());
    await service.search({ symptom: 'webpack HMR cannot apply update', frameworks: ['webpack'] });
    await service.recordFeedback(created.entry.id, true);

    const metrics = await service.getMetrics();
    expect(metrics.captures).toBe(1);
    expect(metrics.retrievals).toBe(1);
    expect(metrics.retrievalsWithHits).toBe(1);
    expect(metrics.accepted).toBe(1);
  });

  it('recordFeedback nudges confidence up when helpful', async () => {
    const { service } = makeService();
    const created = await service.record(draft({ confidence: 0.5 }));
    await service.recordFeedback(created.entry.id, true);
    const after = await service.get(created.entry.id);
    expect(after?.confidence).toBeCloseTo(0.55, 6);
  });

  it('updateConfidence clamps to [0,1]', async () => {
    const { service } = makeService();
    const created = await service.record(draft({ confidence: 0.95 }));
    await service.updateConfidence(created.entry.id, 0.5);
    const after = await service.get(created.entry.id);
    expect(after?.confidence).toBe(1);
  });
});
