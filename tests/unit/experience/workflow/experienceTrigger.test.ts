/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the conditional retrieval trigger.
 */

import { describe, expect, it } from 'vitest';
import { buildSignature, classifySeverity, createExperienceTrigger } from '@/process/experience/workflow/experienceTrigger';

describe('classifySeverity', () => {
  it('marks crashes/OOM/panics as hard', () => {
    expect(classifySeverity('thread panicked at ...')).toBe('hard');
    expect(classifySeverity('FATAL: heap out of memory')).toBe('hard');
    expect(classifySeverity('Segfault (core dumped)')).toBe('hard');
  });

  it('marks ordinary assertion failures as normal', () => {
    expect(classifySeverity('expected 1 to equal 2')).toBe('normal');
  });
});

describe('buildSignature', () => {
  it('joins salient parts lower-cased', () => {
    expect(buildSignature({ command: 'Bun Run Test', errorCategory: 'Test-Failure', file: 'A.ts' })).toBe('bun run test|test-failure|a.ts');
  });

  it('falls back to unknown when empty', () => {
    expect(buildSignature({})).toBe('unknown');
  });
});

describe('createExperienceTrigger', () => {
  it('does not fire below threshold and fires at threshold', () => {
    const trigger = createExperienceTrigger({ threshold: 2 });
    const first = trigger.observe({ projectId: 'p', signature: 's', outcome: 'failed' });
    expect(first.shouldRetrieve).toBe(false);
    expect(first.failureCount).toBe(1);

    const second = trigger.observe({ projectId: 'p', signature: 's', outcome: 'failed' });
    expect(second.shouldRetrieve).toBe(true);
    expect(second.reason).toContain('threshold');
  });

  it('fires immediately on a hard failure', () => {
    const trigger = createExperienceTrigger({ threshold: 3 });
    const decision = trigger.observe({ projectId: 'p', signature: 's', outcome: 'failed', severity: 'hard' });
    expect(decision.shouldRetrieve).toBe(true);
    expect(decision.reason).toBe('hard-failure');
  });

  it('resets the streak on a passing outcome', () => {
    const trigger = createExperienceTrigger({ threshold: 2 });
    trigger.observe({ projectId: 'p', signature: 's', outcome: 'failed' });
    trigger.observe({ projectId: 'p', signature: 's', outcome: 'passed' });
    expect(trigger.peek('p', 's')).toBe(0);
    const next = trigger.observe({ projectId: 'p', signature: 's', outcome: 'failed' });
    expect(next.failureCount).toBe(1);
    expect(next.shouldRetrieve).toBe(false);
  });

  it('tracks distinct signatures independently', () => {
    const trigger = createExperienceTrigger({ threshold: 2 });
    trigger.observe({ projectId: 'p', signature: 'a', outcome: 'failed' });
    const other = trigger.observe({ projectId: 'p', signature: 'b', outcome: 'failed' });
    expect(other.failureCount).toBe(1);
  });

  it('reset and resetAll clear counters', () => {
    const trigger = createExperienceTrigger({ threshold: 2 });
    trigger.observe({ projectId: 'p', signature: 's', outcome: 'failed' });
    trigger.reset('p', 's');
    expect(trigger.peek('p', 's')).toBe(0);
    trigger.observe({ projectId: 'p', signature: 's', outcome: 'failed' });
    trigger.resetAll();
    expect(trigger.peek('p', 's')).toBe(0);
  });
});
