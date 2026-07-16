/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM test for the Testing report screenshot (Yêu cầu 2b, criterion 2.5): the
 * step's PNG is loaded from disk via the image bridge and rendered as an actual
 * image (zoomable), and degrades to an "unavailable" chip when the read fails —
 * so a missing artifact never breaks the report.
 */

import { ConfigProvider } from '@arco-design/web-react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

const getImageBase64 = vi.fn();
vi.mock('@/common', () => ({
  ipcBridge: { fs: { getImageBase64: { invoke: (...args: unknown[]) => getImageBase64(...args) } } },
}));

import ReportScreenshot from '@/renderer/pages/testing/components/ReportScreenshot';

const renderShot = (path: string) =>
  render(
    <ConfigProvider>
      <ReportScreenshot path={path} />
    </ConfigProvider>
  );

describe('ReportScreenshot (Requirement 2b, criterion 2.5)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('loads the PNG from disk and renders it as a data-URL image', async () => {
    getImageBase64.mockResolvedValue('data:image/png;base64,ZZZZ');
    renderShot('/u/testing/abc/1-step.png');

    await waitFor(() => expect(getImageBase64).toHaveBeenCalledWith({ path: '/u/testing/abc/1-step.png' }));
    await waitFor(() => {
      const img = document.querySelector('img[src="data:image/png;base64,ZZZZ"]');
      expect(img).not.toBeNull();
    });
  });

  it('shows an unavailable chip when the image cannot be read', async () => {
    getImageBase64.mockResolvedValue(null);
    renderShot('/u/testing/abc/missing.png');
    await waitFor(() => expect(screen.getByText('testing.report.screenshotUnavailable')).toBeInTheDocument());
  });

  it('shows an unavailable chip when the bridge call rejects', async () => {
    getImageBase64.mockRejectedValue(new Error('boom'));
    renderShot('/u/testing/abc/err.png');
    await waitFor(() => expect(screen.getByText('testing.report.screenshotUnavailable')).toBeInTheDocument());
  });
});
