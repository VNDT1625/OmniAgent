/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM test for the AI app-detection status bar (Yêu cầu 2b — UX). Verifies the
 * bar renders nothing when idle, surfaces the phase label + the file being read,
 * and reflects terminal phases (done/error). Renderer-only, Arco + UnoCSS.
 */

import { ConfigProvider } from '@arco-design/web-react';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
    i18n: { language: 'en' },
  }),
}));

import DetectProgressBar from '@/renderer/pages/testing/components/DetectProgressBar';
import type { DetectProgress } from '@/renderer/pages/testing/testingBridgeClient';

const renderBar = (progress?: DetectProgress) =>
  render(
    <ConfigProvider>
      <DetectProgressBar progress={progress} />
    </ConfigProvider>
  );

describe('DetectProgressBar (Requirement 2b — UX)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders nothing when idle (no progress)', () => {
    const { container } = renderBar(undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the phase label and the file being read', () => {
    renderBar({ projectDir: '/p', phase: 'reading', message: 'docker-compose.yml', percent: 35 });
    expect(screen.getByTestId('detect-progress')).toBeInTheDocument();
    expect(screen.getByText('testing.detect.phase_reading')).toBeInTheDocument();
    expect(screen.getByText('docker-compose.yml')).toBeInTheDocument();
  });

  it('shows the analyzing phase label without a file detail', () => {
    renderBar({ projectDir: '/p', phase: 'analyzing', message: '', percent: 60 });
    expect(screen.getByText('testing.detect.phase_analyzing')).toBeInTheDocument();
  });

  it('surfaces the error message on the error phase', () => {
    renderBar({ projectDir: '/p', phase: 'error', message: 'No project files found' });
    expect(screen.getByText('testing.detect.phase_error')).toBeInTheDocument();
    expect(screen.getByText('No project files found')).toBeInTheDocument();
  });

  it('reflects the done phase', () => {
    renderBar({ projectDir: '/p', phase: 'done', message: '', percent: 100 });
    expect(screen.getByText('testing.detect.phase_done')).toBeInTheDocument();
  });
});
