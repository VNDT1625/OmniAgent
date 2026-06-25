/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createRefreshPipeline, type RtkResearcher } from '@/process/knowledge/realtime/refreshPipeline';
import { createVerificationService } from '@/process/knowledge/realtime/verificationService';

const target = { topic: 'nodejs.lts.version', question: 'latest node lts?', value: '20.x', aliases: ['newest node'] };

const researcher = (answer: string, sources: Array<{ url?: string; title?: string }>): RtkResearcher => ({
  research: vi.fn().mockResolvedValue({ answer, sources }),
});

describe('refreshPipeline', () => {
  it('proposes the first line of the answer and accepts a corroborated change', async () => {
    const pipeline = createRefreshPipeline({
      researcher: researcher('22.x\n(extra prose)', [{ url: 'https://nodejs.org' }, { url: 'https://github.com' }]),
      verifier: createVerificationService(),
      model: 'm',
    });
    const result = await pipeline.refresh(target);
    expect(result.proposedValue).toBe('22.x');
    expect(result.sources).toHaveLength(2);
    expect(result.decision.action).toBe('accept');
    expect(result.decision.changed).toBe(true);
  });

  it('drops sources without a URL when normalising', async () => {
    const pipeline = createRefreshPipeline({
      researcher: researcher('22.x', [{ title: 'no url' }, { url: 'https://nodejs.org' }]),
      verifier: createVerificationService(),
      model: 'm',
    });
    const result = await pipeline.refresh(target);
    expect(result.sources).toHaveLength(1);
  });

  it('reviews a single-source change', async () => {
    const pipeline = createRefreshPipeline({
      researcher: researcher('22.x', [{ url: 'https://nodejs.org' }]),
      verifier: createVerificationService(),
      model: 'm',
    });
    const result = await pipeline.refresh(target);
    expect(result.decision.action).toBe('review');
  });

  it('uses an injected value extractor when provided', async () => {
    const extractValue = vi.fn().mockResolvedValue({ value: '24.x', agreement: [true, true] });
    const pipeline = createRefreshPipeline({
      researcher: researcher('irrelevant prose', [{ url: 'https://a.com' }, { url: 'https://b.com' }]),
      verifier: createVerificationService(),
      extractValue,
      model: 'm',
    });
    const result = await pipeline.refresh(target);
    expect(extractValue).toHaveBeenCalled();
    expect(result.proposedValue).toBe('24.x');
    expect(result.decision.action).toBe('accept');
  });
});
