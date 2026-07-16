/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM test for the Testing report viewer (Task 12.13, Yêu cầu 2b, criterion 2.5):
 * the viewer renders the report .md data — per-step pass/fail rows, screenshots
 * and the recorded video path — IDE-style, and shows an empty state when no
 * report is selected.
 */

import { ConfigProvider } from '@arco-design/web-react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
    i18n: { language: 'en' },
  }),
}));

// Screenshots load their bytes via the image bridge; stub it to a tiny data URL.
const getImageBase64 = vi.fn(async () => 'data:image/png;base64,AAAA');
vi.mock('@/common', () => ({
  ipcBridge: { fs: { getImageBase64: { invoke: (...args: unknown[]) => getImageBase64(...args) } } },
}));

import ReportViewer from '@/renderer/pages/testing/components/ReportViewer';
import type { TestingReport } from '@/renderer/pages/testing/testingBridgeClient';

const report: TestingReport = {
  sessionId: 'sess-1',
  scenarioName: 'Login flow',
  platform: 'web',
  passed: false,
  total: 2,
  passedCount: 1,
  steps: [
    { index: 1, description: 'Open login page', passed: true, screenshots: ['/a/s1.png'] },
    {
      index: 2,
      description: 'Submit credentials',
      passed: false,
      detail: 'wrong password',
      screenshots: ['/a/s2.png'],
    },
  ],
  videoPath: '/a/rec.webm',
};

const renderViewer = (r?: TestingReport) => render(<ConfigProvider>{<ReportViewer report={r} />}</ConfigProvider>);

describe('ReportViewer (Requirement 2b, criterion 2.5)', () => {
  afterEach(() => {
    cleanup();
    getImageBase64.mockClear();
  });

  it('shows an empty state when no report is selected', () => {
    renderViewer(undefined);
    expect(screen.getByText('testing.report.empty')).toBeInTheDocument();
  });

  it('renders the scenario name, platform and a row per step', () => {
    renderViewer(report);
    expect(screen.getByText('Login flow')).toBeInTheDocument();
    expect(screen.getByText('web')).toBeInTheDocument();
    const steps = screen.getAllByTestId('report-step');
    expect(steps).toHaveLength(2);
    expect(screen.getByText('1. Open login page')).toBeInTheDocument();
    expect(screen.getByText('2. Submit credentials')).toBeInTheDocument();
  });

  it('shows the failure detail and the recorded video path', () => {
    renderViewer(report);
    expect(screen.getByText('wrong password')).toBeInTheDocument();
    expect(screen.getByText('/a/rec.webm')).toBeInTheDocument();
  });

  it('loads each step screenshot from disk via the image bridge', async () => {
    renderViewer(report);
    // One getImageBase64 call per screenshot (2 steps × 1 shot each).
    await waitFor(() => expect(getImageBase64).toHaveBeenCalledWith({ path: '/a/s1.png' }));
    expect(getImageBase64).toHaveBeenCalledWith({ path: '/a/s2.png' });
    // The rendered images use the stubbed data URL.
    await waitFor(() => {
      const imgs = document.querySelectorAll('img[src="data:image/png;base64,AAAA"]');
      expect(imgs.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('reflects the overall failed status', () => {
    renderViewer(report);
    expect(screen.getByText('testing.report.failed')).toBeInTheDocument();
  });
});
