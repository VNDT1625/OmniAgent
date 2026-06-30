/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the ExpBase metrics store.
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acceptanceRate, createExperienceMetrics, hitRate } from '@/process/experience/workflow/experienceMetrics';
import { createMemFs } from '../memFs';

const ROOT = path.join('metrics-root');

const makeMetrics = () =>
  createExperienceMetrics({ projectId: 'p', rootDir: ROOT, fs: createMemFs(), now: () => '2026-06-09T00:00:00.000Z' });

describe('createExperienceMetrics', () => {
  it('starts empty', async () => {
    const snapshot = await makeMetrics().snapshot();
    expect(snapshot).toMatchObject({ retrievals: 0, retrievalsWithHits: 0, accepted: 0, falseMatches: 0, captures: 0 });
  });

  it('records retrievals and hits', async () => {
    const metrics = makeMetrics();
    await metrics.recordRetrieval(3);
    await metrics.recordRetrieval(0);
    const snapshot = await metrics.snapshot();
    expect(snapshot.retrievals).toBe(2);
    expect(snapshot.retrievalsWithHits).toBe(1);
  });

  it('records feedback and captures', async () => {
    const metrics = makeMetrics();
    await metrics.recordFeedback(true);
    await metrics.recordFeedback(false);
    await metrics.recordCapture();
    await metrics.recordSuggestionsShown(5);
    const snapshot = await metrics.snapshot();
    expect(snapshot.accepted).toBe(1);
    expect(snapshot.falseMatches).toBe(1);
    expect(snapshot.captures).toBe(1);
    expect(snapshot.suggestionsShown).toBe(5);
  });

  it('persists across instances on the same fs', async () => {
    const fsImpl = createMemFs();
    const a = createExperienceMetrics({ projectId: 'p', rootDir: ROOT, fs: fsImpl, now: () => 'now' });
    await a.recordCapture();
    const b = createExperienceMetrics({ projectId: 'p', rootDir: ROOT, fs: fsImpl, now: () => 'now' });
    expect((await b.snapshot()).captures).toBe(1);
  });

  it('computes hit and acceptance rates', () => {
    expect(
      hitRate({
        retrievals: 4,
        retrievalsWithHits: 3,
        suggestionsShown: 0,
        accepted: 0,
        falseMatches: 0,
        captures: 0,
        updatedAt: '',
      })
    ).toBe(0.75);
    expect(
      acceptanceRate({
        retrievals: 0,
        retrievalsWithHits: 0,
        suggestionsShown: 0,
        accepted: 3,
        falseMatches: 1,
        captures: 0,
        updatedAt: '',
      })
    ).toBe(0.75);
    expect(
      hitRate({
        retrievals: 0,
        retrievalsWithHits: 0,
        suggestionsShown: 0,
        accepted: 0,
        falseMatches: 0,
        captures: 0,
        updatedAt: '',
      })
    ).toBe(0);
  });
});
