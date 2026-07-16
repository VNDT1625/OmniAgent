/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for the Quick Active sidebar section — the collapsible group in the
 * left sidebar (alongside Conversations / Team / Company) that lists the
 * surfaces running right now (open browser tabs, active test sessions) and jumps
 * to them.
 *
 * Focus:
 * - it aggregates open browser tabs + active test sessions into grouped rows;
 * - clicking a browser-tab row stashes a tab hand-off and navigates to Browser;
 * - clicking a test-session row stashes a session hand-off and navigates to
 *   Testing;
 * - it renders nothing when nothing is active (no empty noise in the sidebar);
 * - it renders nothing on non-desktop builds.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from '@arco-design/web-react';

// --- i18n: identity translator so assertions can use the raw key strings -----
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

// --- react-router: capture navigation targets ---------------------------------
const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

// --- desktop gate: default to desktop (overridden per-test) --------------------
const platformMock = vi.hoisted(() => ({ isElectronDesktop: vi.fn(() => true) }));
vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: platformMock.isElectronDesktop,
}));

// --- sider tooltip / focus helpers: no-op stubs --------------------------------
vi.mock('@renderer/utils/ui/siderTooltip', () => ({ cleanupSiderTooltips: vi.fn() }));
vi.mock('@renderer/utils/ui/focus', () => ({ blurActiveElement: vi.fn() }));

// --- browser + testing bridge clients: configurable list stubs ----------------
const browserMock = vi.hoisted(() => ({ listTabs: vi.fn() }));
vi.mock('@/renderer/pages/browser/browserBridgeClient', () => ({
  browserClient: browserMock,
}));
const testingMock = vi.hoisted(() => ({ listSessions: vi.fn() }));
vi.mock('@/renderer/pages/testing/testingBridgeClient', () => ({
  testingClient: testingMock,
}));

// --- browser + testing hand-off setters ---------------------------------------
const handoffMock = vi.hoisted(() => ({
  requestActiveTab: vi.fn(),
  requestActiveSession: vi.fn(),
}));
vi.mock('@/renderer/pages/browser/constants', () => ({
  requestActiveTab: handoffMock.requestActiveTab,
}));
vi.mock('@/renderer/pages/testing/constants', () => ({
  requestActiveSession: handoffMock.requestActiveSession,
}));

import QuickActiveSiderSection from '@/renderer/components/agent/QuickActive/QuickActiveSiderSection';

const renderSection = (pathname = '/guid') =>
  render(
    <ConfigProvider>
      {<QuickActiveSiderSection collapsed={false} pathname={pathname} siderTooltipProps={{}} />}
    </ConfigProvider>
  );

const user = userEvent.setup();

describe('QuickActiveSiderSection', () => {
  beforeEach(() => {
    platformMock.isElectronDesktop.mockReturnValue(true);
    browserMock.listTabs.mockResolvedValue([]);
    testingMock.listSessions.mockResolvedValue([]);
    handoffMock.requestActiveTab.mockReset();
    handoffMock.requestActiveSession.mockReset();
    navigateMock.mockReset();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing on non-desktop builds', () => {
    platformMock.isElectronDesktop.mockReturnValue(false);
    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when no surfaces are active', async () => {
    browserMock.listTabs.mockResolvedValue([]);
    testingMock.listSessions.mockResolvedValue([]);
    const { container } = renderSection();
    await waitFor(() => expect(browserMock.listTabs).toHaveBeenCalled());
    await waitFor(() => expect(testingMock.listSessions).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('lists open browser tabs and navigates + hands off the tab on click', async () => {
    browserMock.listTabs.mockResolvedValue([
      {
        id: 'tab-yt',
        title: 'YouTube',
        url: 'https://youtube.com',
        visible: true,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      },
    ]);
    renderSection();

    const row = await screen.findByText('YouTube');
    await user.click(row);

    expect(handoffMock.requestActiveTab).toHaveBeenCalledWith('tab-yt');
    expect(navigateMock).toHaveBeenCalledWith('/settings/browser');
  });

  it('lists active test sessions and navigates + hands off the session on click', async () => {
    testingMock.listSessions.mockResolvedValue([
      { sessionId: 'sess-1', name: 'Login flow', platform: 'web', status: 'running' },
    ]);
    renderSection();

    const row = await screen.findByText('Login flow');
    await user.click(row);

    expect(handoffMock.requestActiveSession).toHaveBeenCalledWith('sess-1');
    expect(navigateMock).toHaveBeenCalledWith('/settings/testing');
  });

  it('shows the group headers for browser and testing when both are active', async () => {
    browserMock.listTabs.mockResolvedValue([
      {
        id: 'tab-1',
        title: 'Example',
        url: 'https://example.com',
        visible: true,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      },
    ]);
    testingMock.listSessions.mockResolvedValue([
      { sessionId: 'sess-1', name: 'Smoke', platform: 'web', status: 'passed' },
    ]);
    renderSection();

    expect(await screen.findByText('quickActive.group.browser')).toBeInTheDocument();
    expect(await screen.findByText('quickActive.group.testing')).toBeInTheDocument();
    expect(await screen.findByText('quickActive.title')).toBeInTheDocument();
  });
});
