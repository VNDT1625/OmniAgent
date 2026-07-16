/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { analyzePhaseGates } from '@/common/spec/phaseGates';

describe('analyzePhaseGates', () => {
  it('parses phases, counts tasks and computes gate openness', () => {
    const md = [
      '# Tasks',
      '',
      '## Phase 1 — Core',
      '- [x] T1 — A',
      '- [x] T2 — B',
      '',
      '## Phase 2 — Integration',
      '- [x] T3 — C',
      '- [ ] T4 — D',
    ].join('\n');
    const result = analyzePhaseGates(md);
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0].gateOpen).toBe(true);
    expect(result.phases[1].gateOpen).toBe(false);
    expect(result.activePhaseIndex).toBe(2);
  });

  it('detects checkpoints and definition of done', () => {
    const md = [
      '# Tasks',
      '',
      '## Definition of Done',
      'A task is done when tests pass.',
      '',
      '## Phase 1 — Core',
      '- [x] T1 — A',
      '- [x] T2 — CHECKPOINT Phase 1 verified',
    ].join('\n');
    const result = analyzePhaseGates(md);
    expect(result.hasDefinitionOfDone).toBe(true);
    expect(result.phases[0].hasCheckpoint).toBe(true);
    expect(result.phases[0].gateOpen).toBe(true);
    expect(result.activePhaseIndex).toBeNull();
  });

  it('warns when there is no definition of done and flags phases without checkpoints', () => {
    const md = ['# Tasks', '', '## Phase 1 — Core', '- [ ] T1 — A'].join('\n');
    const result = analyzePhaseGates(md);
    expect(result.diagnostics.some((d) => d.code === 'spec.noDefinitionOfDone')).toBe(true);
    expect(result.diagnostics.some((d) => d.code === 'phase.noCheckpoint')).toBe(true);
  });

  it('keeps the gate closed when a checkpoint task is not done', () => {
    const md = ['# Tasks', '', '## Phase 1 — Core', '- [x] T1 — A', '- [ ] T2 — CHECKPOINT verify'].join('\n');
    const result = analyzePhaseGates(md);
    expect(result.phases[0].gateOpen).toBe(false);
    expect(result.activePhaseIndex).toBe(1);
  });
});
