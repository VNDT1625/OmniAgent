/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for the SpecManagerPanel — the spec-driven workflow health view.
 *
 * The panel calls `ideClient.specAnalyze` and renders the readiness score,
 * EARS requirements, the traceability matrix and phase gates. We mock the
 * client so the panel's rendering is exercised without IPC.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from '@arco-design/web-react';
import type { SpecAnalysis } from '@/common/spec';

// i18n: identity translator so assertions can use raw key strings.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => {
      if (!opts) return k;
      const parts = Object.entries(opts)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(',');
      return `${k}(${parts})`;
    },
    i18n: { language: 'en' },
  }),
}));

const specAnalyze = vi.fn();
const specStatus = vi.fn();
const specAdvancePhase = vi.fn();
vi.mock('@/renderer/pages/studio/ide/ideClient', () => ({
  ideClient: {
    specAnalyze: (...args: unknown[]) => specAnalyze(...args),
    specStatus: (...args: unknown[]) => specStatus(...args),
    specAdvancePhase: (...args: unknown[]) => specAdvancePhase(...args),
  },
}));

import SpecManagerPanel from '@/renderer/pages/studio/ide/components/SpecManagerPanel';

const analysis: SpecAnalysis = {
  slug: 'demo',
  requirements: {
    requirements: [
      {
        id: 'R1',
        title: 'Capture',
        line: 3,
        userStory: null,
        criteria: [{ line: 4, text: 'WHEN x, THEN the system SHALL store it.', pattern: 'event', hasShall: true }],
      },
    ],
    diagnostics: [],
    counts: { total: 1, withCriteria: 1, earsCompliant: 1 },
  },
  traceability: {
    rows: [{ reqId: 'R1', reqTitle: 'Capture', taskIds: ['t1'], hasDoneTask: true, verified: true }],
    uncoveredReqIds: [],
    orphanTaskIds: [],
    diagnostics: [],
    counts: { requirements: 1, coveredRequirements: 1, verifiedRequirements: 1, orphanTasks: 0 },
  },
  phaseGates: {
    phases: [
      {
        index: 1,
        title: 'Phase 1 — Build',
        line: 5,
        taskIds: ['t1'],
        counts: { total: 1, done: 1, blocked: 0 },
        hasCheckpoint: true,
        gateOpen: true,
      },
    ],
    hasDefinitionOfDone: true,
    activePhaseIndex: null,
    diagnostics: [],
  },
  score: 95,
  diagnostics: [],
};

const renderPanel = (rootPath: string | null = '/repo') =>
  render(
    <ConfigProvider>
      <SpecManagerPanel rootPath={rootPath} />
    </ConfigProvider>
  );

beforeEach(() => {
  specAnalyze.mockReset();
  specStatus.mockReset();
  specAdvancePhase.mockReset();
  specStatus.mockResolvedValue({
    ok: true,
    data: {
      rootPath: '/repo',
      exists: true,
      hasAnySpec: true,
      slug: 'demo',
      specDir: '/repo/.aionui/specs/demo',
      phase: 'tasks',
      approvals: { requirements: true, design: true, tasks: false },
      files: {
        'requirements.md': true,
        'design.md': true,
        'tasks.md': true,
        'verification.md': false,
      },
      taskCounts: { total: 1, done: 1, pending: 0, inProgress: 0, blocked: 0 },
      updatedAt: 12,
    },
  });
});

afterEach(() => {
  cleanup();
});

describe('SpecManagerPanel', () => {
  it('shows the no-folder empty state when rootPath is null', () => {
    renderPanel(null);
    expect(screen.getByText('ide.spec.noFolder')).toBeTruthy();
    expect(specAnalyze).not.toHaveBeenCalled();
  });

  it('renders the score, requirements, traceability and phases on success', async () => {
    specAnalyze.mockResolvedValue({ ok: true, data: analysis });
    renderPanel('/repo');
    await waitFor(() => expect(screen.getByText('ide.spec.title')).toBeTruthy());
    // Score gauge value.
    expect(screen.getByText('95')).toBeTruthy();
    // Requirement id + title (appears in both requirements list and trace row).
    expect(screen.getAllByText('Capture').length).toBeGreaterThanOrEqual(1);
    // The all-clear banner (no diagnostics).
    expect(screen.getByText('ide.spec.allClear')).toBeTruthy();
    expect(specAnalyze).toHaveBeenCalledWith('/repo');
    expect(specStatus).toHaveBeenCalledWith('/repo');
  });

  it('shows an error state when analysis fails', async () => {
    specAnalyze.mockResolvedValue({ ok: false, error: 'boom' });
    renderPanel('/repo');
    await waitFor(() => expect(screen.getByText('ide.spec.error(error=boom)')).toBeTruthy());
  });
});
