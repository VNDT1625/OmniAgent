/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { analyzeSpec, computeSpecScore } from '@/common/spec';

const goodSpec = {
  slug: 'demo',
  requirementsMarkdown: [
    '# Demo Requirements',
    '',
    '## R1 Capture',
    '- WHEN a fix is verified, THEN the system SHALL store an entry.',
    '',
    '## R2 Retrieve',
    '- The system SHALL rank entries by similarity.',
  ].join('\n'),
  tasksMarkdown: [
    '# Tasks',
    '',
    '## Definition of Done',
    'A task is done when tests pass and the requirement is covered.',
    '',
    '## Phase 1 — Build',
    '- [x] T1 — Implement capture (Req: R1)',
    '- [x] T2 — Implement retrieval (Req: R2)',
    '- [x] T3 — CHECKPOINT phase 1 verified',
  ].join('\n'),
  verificationMarkdown: '## Verification\n- R1 verified by tests.\n- R2 verified by tests.',
};

describe('analyzeSpec', () => {
  it('produces a high score for a disciplined spec', () => {
    const analysis = analyzeSpec(goodSpec);
    expect(analysis.requirements.counts.total).toBe(2);
    expect(analysis.traceability.counts.coveredRequirements).toBe(2);
    expect(analysis.traceability.counts.verifiedRequirements).toBe(2);
    expect(analysis.phaseGates.hasDefinitionOfDone).toBe(true);
    expect(analysis.score).toBeGreaterThanOrEqual(90);
  });

  it('scores zero when there are no requirements', () => {
    const analysis = analyzeSpec({
      slug: 'empty',
      requirementsMarkdown: '# Nothing here',
      tasksMarkdown: '# Tasks',
      verificationMarkdown: '',
    });
    expect(analysis.score).toBe(0);
  });

  it('sorts diagnostics errors first', () => {
    const analysis = analyzeSpec({
      slug: 'mixed',
      requirementsMarkdown: ['# T', '', '## R1 A', '- The system SHALL a.'].join('\n'),
      tasksMarkdown: ['# Tasks', '', '## Phase 1 — X', '- [ ] T1 — Build (Req: R9)'].join('\n'),
      verificationMarkdown: '',
    });
    expect(analysis.diagnostics[0].severity).toBe('error');
    expect(analysis.diagnostics.some((d) => d.code === 'task.unknownReq')).toBe(true);
  });

  it('penalizes coverage gaps in the score', () => {
    const partial = analyzeSpec({
      ...goodSpec,
      tasksMarkdown: ['# Tasks', '', '## Phase 1 — Build', '- [ ] T1 — Implement capture (Req: R1)'].join('\n'),
      verificationMarkdown: '',
    });
    expect(partial.score).toBeLessThan(analyzeSpec(goodSpec).score);
  });
});

describe('computeSpecScore', () => {
  it('is deterministic and bounded 0..100', () => {
    const analysis = analyzeSpec(goodSpec);
    const score = computeSpecScore(analysis);
    expect(score).toBe(analysis.score);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});
