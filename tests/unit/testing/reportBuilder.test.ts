/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/testing/reportBuilder (Yêu cầu 2b, criterion 2.5):
 * the builder turns a finished session into a Markdown report + structured data.
 */

import { describe, expect, it } from 'vitest';
import { buildReport } from '@/process/testing/reportBuilder';
import type { TestSession } from '@/process/testing/testingTypes';

const baseSession = (overrides: Partial<TestSession> = {}): TestSession => ({
  id: 'sess-1',
  scenario: {
    id: 'scn-1',
    name: 'Login flow',
    platform: 'web',
    steps: [
      { id: 's1', description: 'Open login page' },
      { id: 's2', description: 'Submit credentials' },
    ],
  },
  visibility: 'hidden',
  status: 'passed',
  results: [
    { step: { id: 's1', description: 'Open login page' }, passed: true, screenshots: ['/a/s1.png'], at: 1 },
    { step: { id: 's2', description: 'Submit credentials' }, passed: true, screenshots: ['/a/s2.png'], at: 2 },
  ],
  videoPath: '/a/rec.webm',
  createdAt: 0,
  updatedAt: 2,
  ...overrides,
});

describe('buildReport', () => {
  it('produces a markdown table with one row per step', () => {
    const { markdown } = buildReport(baseSession());
    expect(markdown).toContain('# Test Report: Login flow');
    expect(markdown).toContain('| 1 | Open login page | ✅ |');
    expect(markdown).toContain('| 2 | Submit credentials | ✅ |');
    expect(markdown).toContain('**Video:** /a/rec.webm');
    expect(markdown).toContain('![](/a/s1.png)');
  });

  it('reports overall PASSED only when every step passed', () => {
    const { structured } = buildReport(baseSession());
    expect(structured.passed).toBe(true);
    expect(structured.passedCount).toBe(2);
    expect(structured.total).toBe(2);
  });

  it('reports FAILED when any step failed', () => {
    const session = baseSession({
      status: 'failed',
      results: [
        { step: { id: 's1', description: 'Open login page' }, passed: true, screenshots: [], at: 1 },
        {
          step: { id: 's2', description: 'Submit credentials' },
          passed: false,
          detail: 'wrong password',
          screenshots: [],
          at: 2,
        },
      ],
    });
    const { markdown, structured } = buildReport(session);
    expect(structured.passed).toBe(false);
    expect(markdown).toContain('❌ FAILED');
    expect(markdown).toContain('wrong password');
  });

  it('marks ERROR status distinctly and surfaces the error', () => {
    const session = baseSession({ status: 'error', error: 'display unavailable', results: [] });
    const { markdown, structured } = buildReport(session);
    expect(markdown).toContain('⚠️ ERROR');
    expect(markdown).toContain('display unavailable');
    expect(structured.passed).toBe(false);
  });

  it('escapes pipe characters in step detail so the table stays valid', () => {
    const session = baseSession({
      status: 'failed',
      results: [{ step: { id: 's1', description: 'a | b' }, passed: false, detail: 'x | y', screenshots: [], at: 1 }],
    });
    const { markdown } = buildReport(session);
    expect(markdown).toContain('a \\| b');
    expect(markdown).toContain('x \\| y');
  });
});
