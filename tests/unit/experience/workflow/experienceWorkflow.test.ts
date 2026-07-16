/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the agent-workflow orchestrator (Phase 2).
 */

import { describe, expect, it, vi } from 'vitest';
import { createExperienceWorkflow, type WorkflowService } from '@/process/experience/workflow/experienceWorkflow';
import { createExperienceTrigger } from '@/process/experience/workflow/experienceTrigger';
import type { CaptureResult, ExperienceSuggestion } from '@/process/experience/experienceTypes';

const suggestion: ExperienceSuggestion = {
  entryId: 'e1',
  score: 0.7,
  kind: 'successful_fix',
  symptom: 's',
  lesson: 'l',
  whyRelevant: [],
  caution: [],
  suggestedChecks: [],
};

const fakeService = (overrides: Partial<WorkflowService> = {}): WorkflowService => ({
  record: vi.fn(async () => ({ action: 'created', entry: { id: 'e1' } }) as unknown as CaptureResult),
  search: vi.fn(async () => [suggestion]),
  recordFeedback: vi.fn(async () => true),
  ...overrides,
});

describe('createExperienceWorkflow.onVerifyOutcome', () => {
  it('does not retrieve on the first ordinary failure', async () => {
    const service = fakeService();
    const workflow = createExperienceWorkflow({ service, trigger: createExperienceTrigger({ threshold: 2 }) });
    const result = await workflow.onVerifyOutcome(
      { command: 'bun run test', errorText: 'expected a to equal b' },
      'p',
      'failed'
    );
    expect(result.decision.shouldRetrieve).toBe(false);
    expect(result.suggestions).toEqual([]);
    expect(service.search).not.toHaveBeenCalled();
  });

  it('retrieves once stuck (threshold reached)', async () => {
    const service = fakeService();
    const workflow = createExperienceWorkflow({ service, trigger: createExperienceTrigger({ threshold: 2 }) });
    await workflow.onVerifyOutcome({ command: 'bun run test', errorText: 'fail' }, 'p', 'failed');
    const result = await workflow.onVerifyOutcome({ command: 'bun run test', errorText: 'fail' }, 'p', 'failed');
    expect(result.decision.shouldRetrieve).toBe(true);
    expect(result.suggestions).toEqual([suggestion]);
    expect(service.search).toHaveBeenCalledTimes(1);
  });

  it('retrieves immediately on a hard failure', async () => {
    const service = fakeService();
    const workflow = createExperienceWorkflow({ service });
    const result = await workflow.onVerifyOutcome(
      { command: 'bun start', errorText: 'thread panicked at unwrap' },
      'p',
      'failed'
    );
    expect(result.decision.shouldRetrieve).toBe(true);
    expect(service.search).toHaveBeenCalledTimes(1);
  });

  it('does not retrieve on a passing outcome and resets the streak', async () => {
    const service = fakeService();
    const trigger = createExperienceTrigger({ threshold: 2 });
    const workflow = createExperienceWorkflow({ service, trigger });
    await workflow.onVerifyOutcome({ command: 'c', errorText: 'fail' }, 'p', 'failed');
    const passed = await workflow.onVerifyOutcome({ command: 'c' }, 'p', 'passed');
    expect(passed.decision.shouldRetrieve).toBe(false);
    expect(trigger.peek('p', 'c')).toBe(0);
  });
});

describe('createExperienceWorkflow capture + feedback', () => {
  it('captureSuccess records a successful_fix and resets the streak', async () => {
    const service = fakeService();
    const trigger = createExperienceTrigger({ threshold: 1 });
    trigger.observe({ projectId: 'p', signature: 'sig', outcome: 'failed' });
    const workflow = createExperienceWorkflow({ service, trigger });

    await workflow.captureSuccess({ projectId: 'p', symptoms: { summary: 'x' } }, { projectId: 'p', signature: 'sig' });
    expect(service.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'successful_fix' }));
    expect(trigger.peek('p', 'sig')).toBe(0);
  });

  it('captureFailure defaults to failed_attempt', async () => {
    const service = fakeService();
    const workflow = createExperienceWorkflow({ service });
    await workflow.captureFailure({ projectId: 'p', symptoms: { summary: 'x' } });
    expect(service.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed_attempt' }));
  });

  it('recordFeedback delegates to the service', async () => {
    const service = fakeService();
    const workflow = createExperienceWorkflow({ service });
    await workflow.recordFeedback('e1', true);
    expect(service.recordFeedback).toHaveBeenCalledWith('e1', true);
  });
});
