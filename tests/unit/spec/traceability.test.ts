/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { analyzeRequirements } from '@/common/spec/earsRequirements';
import {
  analyzeTraceability,
  extractReqRefs,
  extractVerifiedReqIds,
  parseTraceTasks,
} from '@/common/spec/traceability';

describe('extractReqRefs', () => {
  it('extracts ids from (Req: ...) and _Requirements: ..._ forms', () => {
    expect(extractReqRefs('T7 — Implement store. (Req: R1, R2)')).toEqual(['R1', 'R2']);
    expect(extractReqRefs('Build it _Requirements: R3_')).toEqual(['R3']);
    expect(extractReqRefs('No refs here')).toEqual([]);
  });
});

describe('parseTraceTasks', () => {
  it('parses tasks with status and refs', () => {
    const md = ['# Tasks', '', '- [x] T1 — Do thing (Req: R1)', '- [ ] T2 — Other (Req: R2)'].join('\n');
    const tasks = parseTraceTasks(md);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].status).toBe('done');
    expect(tasks[0].reqRefs).toEqual(['R1']);
    expect(tasks[1].status).toBe('pending');
  });
});

describe('extractVerifiedReqIds', () => {
  it('collects requirement ids mentioned in verification', () => {
    const ids = extractVerifiedReqIds('## Verification\n- R1 covered by unit test\n- R3 covered');
    expect(ids.has('R1')).toBe(true);
    expect(ids.has('R3')).toBe(true);
    expect(ids.has('R2')).toBe(false);
  });
});

describe('analyzeTraceability', () => {
  const reqMd = [
    '# T',
    '',
    '## R1 A',
    '- The system SHALL a.',
    '',
    '## R2 B',
    '- The system SHALL b.',
    '',
    '## R3 C',
    '- The system SHALL c.',
  ].join('\n');
  const requirements = analyzeRequirements(reqMd).requirements;

  it('builds coverage rows and finds uncovered requirements', () => {
    const tasksMd = ['# Tasks', '', '- [x] T1 — Implement A (Req: R1)', '- [ ] T2 — Implement B (Req: R2)'].join('\n');
    const verificationMd = '## Verification\n- R1 done via tests.';
    const result = analyzeTraceability(requirements, tasksMd, verificationMd);
    expect(result.counts.requirements).toBe(3);
    expect(result.counts.coveredRequirements).toBe(2);
    expect(result.counts.verifiedRequirements).toBe(1);
    expect(result.uncoveredReqIds).toEqual(['R3']);
    const r1 = result.rows.find((row) => row.reqId === 'R1');
    expect(r1?.hasDoneTask).toBe(true);
    expect(r1?.verified).toBe(true);
  });

  it('flags tasks referencing unknown requirements as orphans', () => {
    const tasksMd = ['# Tasks', '', '- [ ] T1 — Implement (Req: R9)'].join('\n');
    const result = analyzeTraceability(requirements, tasksMd, '');
    expect(result.diagnostics.some((d) => d.code === 'task.unknownReq')).toBe(true);
    expect(result.counts.orphanTasks).toBe(1);
  });
});
