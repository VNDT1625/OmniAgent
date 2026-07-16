/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for the embedded Browser UI page (Task 6.9, Requirement 1).
 *
 * Focus — criterion 1.4 ("ba lớp nhận thức theo nhu cầu" / perception layers
 * and the controllable web-agent mode): verify the page wires its agent-mode
 * toggle to the `setAgentMode` bridge channel, that the perception-layer feature
 * switch (Vietnamese subtitle overlay) shows/hides the overlay, and that the
 * page degrades gracefully when the Main-process bridge is not wired yet.
 *
 * The real `useBrowserState` hook runs against a mocked `browserBridgeClient`
 * (no IPC), so toggling controls genuinely round-trips through the client stubs.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from '@arco-design/web-react';
import type { BrowserTabInfo } from '@/renderer/pages/browser/browserBridgeClient';
import { AGENT_MODEL_STORAGE_KEY } from '@/renderer/pages/browser/constants';

// --- i18n: identity translator so assertions can use the raw key strings -----
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

// --- Arco Message: stub the toast API so the agent toggle does not spawn a
//     real portal toast during the test -----------------------------------------
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return {
    ...actual,
    Message: {
      ...actual.Message,
      success: vi.fn(),
      error: vi.fn(),
    },
  };
});

// --- Force desktop mode so the page renders its full surface (the page gates
//     itself to the Electron desktop app) -----------------------------------------
vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
}));

// --- Model provider hook used by AgentModePicker: no real ipcBridge/SWR -------
vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useModelProviderList: () => ({
    providers: [],
    getAvailableModels: () => [] as string[],
    formatModelLabel: (_p: unknown, m?: string) => m ?? '',
  }),
}));

// --- Browser IPC bridge client: configurable vi.fn() stubs (no real IPC) ------
const bridgeMocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  navigate: vi.fn(),
  goBack: vi.fn(),
  goForward: vi.fn(),

  reload: vi.fn(),
  setBounds: vi.fn(),
  setZoom: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  hideAll: vi.fn(),
  listTabs: vi.fn(),
  destroyTab: vi.fn(),
  getAgentMode: vi.fn(),
  setAgentMode: vi.fn(),
  runAgent: vi.fn(),
  cancelAgent: vi.fn(),
  onAgentEvent: vi.fn(),
  onTabUpdated: vi.fn(),
  getPersona: vi.fn(),
  setPersona: vi.fn(),
}));

vi.mock('@/renderer/pages/browser/browserBridgeClient', () => ({
  browserClient: bridgeMocks,
}));

import BrowserPage from '@/renderer/pages/browser/BrowserPage';

const buildTab = (overrides: Partial<BrowserTabInfo> = {}): BrowserTabInfo => ({
  id: 'tab-1',
  url: 'https://example.com',
  title: 'Example',
  visible: true,
  bounds: { x: 0, y: 0, width: 0, height: 0 },
  ...overrides,
});

const renderPage = () => render(<ConfigProvider>{<BrowserPage />}</ConfigProvider>);

/** Reveal the agent-controls row (collapsed by default for a compact browser bar). */
const expandControls = async () => {
  const chevron = await screen.findByLabelText('browser.toolbar.expandControls');
  await userEvent.click(chevron);
};

/** Apply the default "bridge is wired, one tab open, agent mode off" stubs. */
const primeReadyBridge = (tabs: BrowserTabInfo[] = [buildTab()]) => {
  bridgeMocks.listTabs.mockResolvedValue(tabs);
  bridgeMocks.getAgentMode.mockResolvedValue({ id: 'tab-1', enabled: false });
  bridgeMocks.setAgentMode.mockResolvedValue({ id: 'tab-1', enabled: true });
  bridgeMocks.openTab.mockResolvedValue({ id: 'tab-2' });
  bridgeMocks.navigate.mockResolvedValue(undefined);
  bridgeMocks.goBack.mockResolvedValue({ navigated: true });
  bridgeMocks.goForward.mockResolvedValue({ navigated: true });

  bridgeMocks.reload.mockResolvedValue(undefined);
  bridgeMocks.destroyTab.mockResolvedValue(undefined);
  bridgeMocks.setBounds.mockResolvedValue(undefined);
  bridgeMocks.setZoom.mockResolvedValue(undefined);
  bridgeMocks.show.mockResolvedValue(undefined);
  bridgeMocks.hide.mockResolvedValue(undefined);
  bridgeMocks.hideAll.mockResolvedValue(undefined);
  bridgeMocks.runAgent.mockResolvedValue({ answer: '', status: 'done', steps: 0 });
  bridgeMocks.cancelAgent.mockResolvedValue(undefined);
  // onAgentEvent must return an unsubscribe function (used as effect cleanup).
  bridgeMocks.onAgentEvent.mockReturnValue(() => {});
  // onTabUpdated must also return an unsubscribe function.
  bridgeMocks.onTabUpdated.mockReturnValue(() => {});
  bridgeMocks.getPersona.mockResolvedValue('');
  bridgeMocks.setPersona.mockResolvedValue(undefined);
};

describe('BrowserPage — perception layers + agent mode (Requirement 1, criterion 1.4)', () => {
  beforeEach(() => {
    Object.values(bridgeMocks).forEach((fn) => fn.mockReset());
    // Safe defaults so lifecycle calls (unmount cleanup, agent-event subscribe)
    // never throw even in tests that don't call primeReadyBridge().
    bridgeMocks.hideAll.mockResolvedValue(undefined);
    bridgeMocks.show.mockResolvedValue(undefined);
    bridgeMocks.setBounds.mockResolvedValue(undefined);
    bridgeMocks.onAgentEvent.mockReturnValue(() => {});
    bridgeMocks.onTabUpdated.mockReturnValue(() => {});
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the key regions (address bar, tab strip, agent-mode picker) without crashing', async () => {
    primeReadyBridge();
    renderPage();

    // Header / title region.
    expect(await screen.findByRole('heading', { name: 'browser.title' })).toBeInTheDocument();
    // Address bar (URL input + reload control).
    expect(screen.getByPlaceholderText('browser.address.placeholder')).toBeInTheDocument();
    expect(screen.getByLabelText('browser.address.reload')).toBeInTheDocument();
    // The agent controls row is collapsed by default — reveal it.
    await expandControls();
    // Tab strip (new-tab control).
    expect(screen.getByLabelText('browser.tab.new')).toBeInTheDocument();
    // Agent-mode picker (label + the toggle itself).
    expect(screen.getByText('browser.agent.label')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'browser.agent.label' })).toBeInTheDocument();
  });

  it('reloads the active tab through the reload bridge instead of navigating to the URL again', async () => {
    primeReadyBridge([buildTab({ id: 'tab-1', url: 'http://127.0.0.1:47821/ide/mcp' })]);
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { name: 'browser.title' });
    await user.click(screen.getByLabelText('browser.address.reload'));

    await waitFor(() => expect(bridgeMocks.reload).toHaveBeenCalledWith({ id: 'tab-1' }));
    expect(bridgeMocks.navigate).not.toHaveBeenCalled();
  });
  it('shows the empty viewport state and opens a tab when no tabs exist', async () => {
    primeReadyBridge([]);
    const user = userEvent.setup();
    renderPage();

    const openFirst = await screen.findByText('browser.viewport.openFirst');
    expect(openFirst).toBeInTheDocument();

    await user.click(openFirst);
    expect(bridgeMocks.openTab).toHaveBeenCalledTimes(1);
  });

  it('keeps the agent-mode toggle disabled until a model is chosen', async () => {
    // No model in storage → toggle must stay disabled (the "pick a model first" path).
    primeReadyBridge();
    renderPage();

    await expandControls();
    const toggle = await screen.findByRole('switch', { name: 'browser.agent.label' });
    await waitFor(() => expect(bridgeMocks.getAgentMode).toHaveBeenCalled());
    expect(toggle).toBeDisabled();
    expect(bridgeMocks.setAgentMode).not.toHaveBeenCalled();
  });

  it('enabling agent mode calls setAgentMode with the active tab id + enabled flag and reflects the new state', async () => {
    // Seed a chosen model so the toggle is enabled once a tab is active.
    window.localStorage.setItem(AGENT_MODEL_STORAGE_KEY, 'kr/claude-opus');
    primeReadyBridge();
    const user = userEvent.setup();
    renderPage();

    await expandControls();
    const toggle = await screen.findByRole('switch', { name: 'browser.agent.label' });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    await waitFor(() => expect(bridgeMocks.setAgentMode).toHaveBeenCalledWith({ id: 'tab-1', enabled: true }));
    // UI reflects the toggled-on state.
    await waitFor(() => expect(screen.getByRole('switch', { name: 'browser.agent.label' })).toBeChecked());
  });

  it('toggling the Vietnamese subtitle overlay shows then hides the overlay (perception-layer switch)', async () => {
    primeReadyBridge();
    const user = userEvent.setup();
    renderPage();

    // Overlay is hidden until the feature is switched on.
    await screen.findByRole('heading', { name: 'browser.title' });
    expect(screen.queryByText('browser.subtitle_overlay.idle')).not.toBeInTheDocument();

    // Enable → overlay (idle hint) appears.
    await user.click(await screen.findByLabelText('browser.subtitle_overlay.enable'));
    expect(await screen.findByText('browser.subtitle_overlay.idle')).toBeInTheDocument();

    // Disable → overlay disappears.
    await user.click(await screen.findByLabelText('browser.subtitle_overlay.disable'));
    await waitFor(() => expect(screen.queryByText('browser.subtitle_overlay.idle')).not.toBeInTheDocument());
  });

  it('renders the friendly bridge notice (no crash) when the client rejects, and retries on demand', async () => {
    bridgeMocks.listTabs.mockRejectedValue(new Error('bridge not wired'));
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('browser.bridgeUnavailable')).toBeInTheDocument();
    const retry = screen.getByText('browser.retry');
    expect(retry).toBeInTheDocument();

    const callsBeforeRetry = bridgeMocks.listTabs.mock.calls.length;
    await user.click(retry);
    await waitFor(() => expect(bridgeMocks.listTabs.mock.calls.length).toBeGreaterThan(callsBeforeRetry));
  });
});
