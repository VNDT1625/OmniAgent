/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM test for the AI scenario-generation status bar (Yêu cầu 2b — UX). Verifies
 * the bar renders nothing when idle, surfaces the phase label + the model id
 * while thinking, the step count on done, and the error message on failure.
 * Renderer-only, Arco + UnoCSS.
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

import GenerateProgressBar from '@/renderer/pages/testing/components/GenerateProgressBar';
import type { GenerateProgress } from '@/renderer/pages/testing/testingBridgeClient';

const renderBar = (progress?: GenerateProgress) =>
  render(
    <ConfigProvider>
      <GenerateProgressBar progress={progress} />
    </ConfigProvider>
  );

describe('GenerateProgressBar (Requirement 2b — UX)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders nothing when idle (no progress)', () => {
    const { container } = renderBar(undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the thinking phase label and the model id', () => {
    renderBar({ phase: 'thinking', message: 'gpt-4o-mini', percent: 45 });
    expect(screen.getByTestId('generate-progress')).toBeInTheDocument();
    expect(screen.getByText('testing.generate.phase_thinking')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
  });

  it('shows the preparing phase label without an inline detail', () => {
    renderBar({ phase: 'preparing', message: 'open the dashboard', percent: 10 });
    expect(screen.getByText('testing.generate.phase_preparing')).toBeInTheDocument();
  });

  it('reflects the done phase with a translated step count', () => {
    renderBar({ phase: 'done', message: '4', percent: 100 });
    expect(screen.getByText('testing.generate.phase_done')).toBeInTheDocument();
    expect(screen.getByText('testing.generate.stepsCount {"count":4}')).toBeInTheDocument();
  });

  it('surfaces the error message on the error phase', () => {
    renderBar({ phase: 'error', message: 'No usable model is configured' });
    expect(screen.getByText('testing.generate.phase_error')).toBeInTheDocument();
    expect(screen.getByText('No usable model is configured')).toBeInTheDocument();
  });
});
