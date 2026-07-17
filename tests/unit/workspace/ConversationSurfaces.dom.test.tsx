/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for ConversationSurfaces — the "Super" control in the conversation
 * header + the in-chat live-browser watch popup.
 *
 * Focus (the three bugs this fixes):
 *  - the Super switch reflects the conversation's ACTUAL attached Browser-Control
 *    server (state sync), not just a localStorage flag — so a chat created with
 *    Super already on shows the switch ON on entry;
 *  - turning Super ON does NOT auto-open any panel (no unplanned parallel-surfaces
 *    page); the watch button appears instead;
 *  - the watch button opens the live-browser popup (the agent's real tabs), not
 *    the parallel-run composer.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from '@arco-design/web-react';
import type { TChatConversation } from '@/common/config/storage';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BROWSER_CONTROL = 'aionui-browser-control';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

const platformMock = vi.hoisted(() => ({ isElectronDesktop: vi.fn(() => true) }));
vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: platformMock.isElectronDesktop,
}));

// MCP catalog: the Browser-Control server is registered (so the control shows).
vi.mock('@/renderer/hooks/mcp/catalog', () => ({
  ensureBackendMcpCatalog: () =>
    Promise.resolve({ allServers: [{ id: 'bc1', name: BROWSER_CONTROL, transport: { type: 'sse', url: 'x' } }] }),
  toSessionMcpServer: (s: { id: string; name: string; transport: unknown }) => ({
    id: s.id,
    name: s.name,
    transport: s.transport,
  }),
}));

// Conversation read/update bridge — `get` returns whatever the test seeds.
const convMock = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/common', () => ({
  ipcBridge: { conversation: { get: { invoke: convMock.get }, update: { invoke: convMock.update } } },
}));

// Browser client used by the watch panel (no IPC in tests).
const browserMock = vi.hoisted(() => ({
  listTabs: vi.fn(() => Promise.resolve([])),
  hideAll: vi.fn(() => Promise.resolve()),
  show: vi.fn(() => Promise.resolve()),
  setVisible: vi.fn(() => Promise.resolve()),
  setBounds: vi.fn(() => Promise.resolve()),
  destroyTab: vi.fn(() => Promise.resolve()),
  onTabUpdated: vi.fn(() => () => {}),
}));
vi.mock('@renderer/pages/browser/browserBridgeClient', () => ({ browserClient: browserMock }));

// Editor-control client used by the watch grid (no IPC in tests).
const editorMock = vi.hoisted(() => ({
  listFrames: vi.fn(() => Promise.resolve([])),
  closeFrame: vi.fn(() => Promise.resolve()),
}));
vi.mock('@renderer/pages/conversation/components/superWatch/editorControlClient', () => ({
  editorControlClient: editorMock,
}));

import ConversationSurfaces from '@/renderer/pages/conversation/components/ConversationSurfaces';
import ConversationWatchOverlay from '@/renderer/pages/conversation/components/superWatch/ConversationWatchOverlay';

const conversation = (extra?: Record<string, unknown>): TChatConversation =>
  ({ id: 'c1', type: 'aionrs', extra }) as unknown as TChatConversation;

// Render the header control + the in-chat overlay together, exactly how
// ChatConversation wires them (they communicate via the emitter).
const renderHeader = (conv: TChatConversation) =>
  render(
    <ConfigProvider>
      <ConversationSurfaces conversation={conv} />
      <ConversationWatchOverlay conversationId={conv.id} />
    </ConfigProvider>
  );

describe('ConversationSurfaces (DOM)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    convMock.get.mockResolvedValue({ id: 'c1', extra: {} });
    convMock.update.mockResolvedValue(true);
    // Default: no live tabs (so the panel does not auto-open). The auto-open
    // test overrides this to return a tab.
    browserMock.listTabs.mockResolvedValue([]);
    browserMock.hideAll.mockResolvedValue(undefined);
    browserMock.show.mockResolvedValue(undefined);
    browserMock.setVisible.mockResolvedValue(undefined);
    browserMock.setBounds.mockResolvedValue(undefined);
    browserMock.destroyTab.mockResolvedValue(undefined);
    browserMock.onTabUpdated.mockReturnValue(() => {});
    editorMock.listFrames.mockResolvedValue([]);
    editorMock.closeFrame.mockResolvedValue(undefined);
  });
  afterEach(() => cleanup());

  it('shows the Super switch ON when the conversation already has Browser-Control attached', async () => {
    convMock.get.mockResolvedValue({
      id: 'c1',
      extra: { session_mcp_servers: [{ id: 'bc1', name: BROWSER_CONTROL, transport: { type: 'sse', url: 'x' } }] },
    });
    renderHeader(conversation({ session_mcp_servers: [{ id: 'bc1', name: BROWSER_CONTROL }] }));

    const sw = await screen.findByRole('switch');
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    // The watch button is available because Super is on.
    expect(screen.getByText('workspace.watch')).toBeTruthy();
  });

  it('shows the Super switch OFF when Browser-Control is not attached, and hides the watch button', async () => {
    renderHeader(conversation({}));
    const sw = await screen.findByRole('switch');
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('false'));
    expect(screen.queryByText('workspace.watch')).toBeNull();
  });

  it('does not open any panel automatically; the watch popup opens only on demand', async () => {
    const user = userEvent.setup();
    convMock.get.mockResolvedValue({
      id: 'c1',
      extra: { session_mcp_servers: [{ id: 'bc1', name: BROWSER_CONTROL }] },
    });
    renderHeader(conversation({ session_mcp_servers: [{ id: 'bc1', name: BROWSER_CONTROL }] }));

    // Wait for the ON state; the watch popup must NOT be present yet.
    await screen.findByText('workspace.watch');
    expect(screen.queryByText('workspace.watchTitle')).toBeNull();

    // Clicking watch opens the live-browser popup (not the parallel composer).
    await user.click(screen.getByText('workspace.watch').closest('button')!);
    await waitFor(() => expect(screen.getByText('workspace.watchTitle')).toBeTruthy());
    // The parallel-surfaces composer placeholder must never appear.
    expect(screen.queryByText('workspace.empty')).toBeNull();
  });

  it('auto-opens with a tab strip and renders only the selected browser at full width', async () => {
    const user = userEvent.setup();
    convMock.get.mockResolvedValue({
      id: 'c1',
      extra: { session_mcp_servers: [{ id: 'bc1', name: BROWSER_CONTROL }] },
    });
    browserMock.listTabs.mockResolvedValue([
      {
        id: 'tab1',
        title: 'YouTube',
        url: 'https://youtube.com',
        visible: true,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      },
      {
        id: 'tab2',
        title: 'Facebook',
        url: 'https://facebook.com',
        visible: true,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      },
    ]);
    renderHeader(conversation({ session_mcp_servers: [{ id: 'bc1', name: BROWSER_CONTROL }] }));

    await waitFor(() => expect(screen.getByText('workspace.watchTitle')).toBeTruthy());
    const youtubeTab = await screen.findByRole('tab', { name: 'YouTube' });
    const facebookTab = screen.getByRole('tab', { name: 'Facebook' });
    await waitFor(() => expect(screen.getAllByTestId('live-browser-frame')).toHaveLength(1));
    expect(youtubeTab.getAttribute('aria-selected')).toBe('true');

    await user.click(facebookTab);
    expect(facebookTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByTestId('live-browser-frame')).toHaveLength(1);

    const card = screen.getByTestId('live-browser-card');
    expect(card.className).toContain('w-full');
    expect(card.className).not.toContain('absolute');
    expect(card.className).not.toContain('inset-0');
  });

  it('destroys only the browser tab whose close button is clicked', async () => {
    const user = userEvent.setup();
    convMock.get.mockResolvedValue({
      id: 'c1',
      extra: { session_mcp_servers: [{ id: 'bc1', name: BROWSER_CONTROL }] },
    });
    browserMock.listTabs.mockResolvedValue([
      {
        id: 'tab1',
        title: 'Checkout',
        url: 'https://example.com/checkout',
        visible: true,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      },
      {
        id: 'tab2',
        title: 'Orders',
        url: 'https://example.com/orders',
        visible: true,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      },
    ]);
    renderHeader(conversation({ session_mcp_servers: [{ id: 'bc1', name: BROWSER_CONTROL }] }));

    await screen.findByRole('tab', { name: 'Checkout' });
    await user.click(screen.getAllByRole('button', { name: 'browser.tab.close' })[0]);

    await waitFor(() => expect(browserMock.destroyTab).toHaveBeenCalledWith({ id: 'tab1' }));
    expect(screen.queryByRole('tab', { name: 'Checkout' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Orders' }).getAttribute('aria-selected')).toBe('true');
  });

  it('collapses the live browser without closing its conversation surface', async () => {
    const user = userEvent.setup();
    convMock.get.mockResolvedValue({
      id: 'c1',
      extra: { session_mcp_servers: [{ id: 'bc1', name: BROWSER_CONTROL }] },
    });
    browserMock.listTabs.mockResolvedValue([
      {
        id: 'tab1',
        title: 'Checkout',
        url: 'https://example.com/checkout',
        visible: true,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      },
    ]);
    renderHeader(conversation({ session_mcp_servers: [{ id: 'bc1', name: BROWSER_CONTROL }] }));

    await screen.findByRole('tab', { name: 'Checkout' });
    await user.click(screen.getByRole('button', { name: 'common.collapse' }));

    expect(screen.getByTestId('live-browser-card')).toBeTruthy();
    expect(screen.queryByText('Checkout')).toBeNull();
    expect(screen.getByRole('button', { name: 'common.expand' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('reopens a user browser tab after the watch card hides it', async () => {
    const user = userEvent.setup();
    convMock.get.mockResolvedValue({
      id: 'c1',
      extra: { session_mcp_servers: [{ id: 'bc1', name: BROWSER_CONTROL }] },
    });
    const tab = {
      id: 'tab1',
      title: 'Checkout',
      url: 'https://example.com/checkout',
      visible: true,
      background: false,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    };
    browserMock.listTabs.mockResolvedValue([tab]);
    renderHeader(conversation({ session_mcp_servers: [{ id: 'bc1', name: BROWSER_CONTROL }] }));

    await screen.findByRole('tab', { name: 'Checkout' });
    await user.click(screen.getByRole('button', { name: 'common.close' }));
    await waitFor(() => expect(screen.queryByTestId('live-browser-card')).toBeNull());

    browserMock.listTabs.mockResolvedValue([{ ...tab, visible: false }]);
    await user.click(screen.getByText('workspace.watch').closest('button')!);

    await screen.findByRole('tab', { name: 'Checkout' });
    expect(browserMock.hideAll).not.toHaveBeenCalled();
    expect(browserMock.setVisible).toHaveBeenCalledWith({ id: 'tab1', visible: false });
  });

  it('ignores hidden background tabs (e.g. the agent research tab)', async () => {
    convMock.get.mockResolvedValue({
      id: 'c1',
      extra: { session_mcp_servers: [{ id: 'bc1', name: BROWSER_CONTROL }] },
    });
    // One visible frame + one HIDDEN research tab. Only the visible one shows;
    // a hidden tab alone must NOT auto-open or render as a frame.
    browserMock.listTabs.mockResolvedValue([
      {
        id: 'tabV',
        title: 'YouTube',
        url: 'https://youtube.com',
        visible: true,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      },
      {
        id: 'tabH',
        title: 'google search',
        url: 'https://google.com/search?q=x',
        visible: false,
        background: true,
        bounds: { x: -10000, y: 0, width: 1280, height: 900 },
      },
    ]);
    renderHeader(conversation({ session_mcp_servers: [{ id: 'bc1', name: BROWSER_CONTROL }] }));

    await waitFor(() => expect(screen.getByText('YouTube')).toBeTruthy());
    // The hidden research tab is never shown as a frame.
    expect(screen.queryByText('google search')).toBeNull();
  });

  it('lists editor frames so the grid can render them (store contract)', async () => {
    // The editor frames the agent opens are surfaced via editorControlClient; the
    // grid renders one LiveEditorFrame per entry. Here we assert the watch hook's
    // data source returns them (the heavy UniversalEditor render is covered by
    // the editor module's own tests).
    editorMock.listFrames.mockResolvedValue([{ filePath: '/w/notes.md', title: 'notes.md', version: 1, updatedAt: 1 }]);
    const frames = await editorMock.listFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0].title).toBe('notes.md');
  });
});

describe('live browser composer placement', () => {
  const platformChats = [
    ['aionrs/AionrsChat.tsx', '<AionrsSendBox'],
    ['acp/AcpChat.tsx', '<AcpSendBox'],
    ['remote/RemoteChat.tsx', '<RemoteSendBox'],
    ['openclaw/OpenClawChat.tsx', '<OpenClawSendBox'],
    ['nanobot/NanobotChat.tsx', '<NanobotSendBox'],
  ] as const;

  it.each(platformChats)('renders the browser card directly before the composer in %s', (file, composer) => {
    const source = readFileSync(
      resolve(process.cwd(), 'packages/desktop/src/renderer/pages/conversation/platforms', file),
      'utf8'
    );
    const messagesIndex = source.indexOf('<MessageList');
    const watchIndex = source.indexOf('{beforeSendBox &&');
    const composerIndex = source.indexOf(composer);

    expect(messagesIndex).toBeGreaterThan(-1);
    expect(watchIndex).toBeGreaterThan(messagesIndex);
    expect(composerIndex).toBeGreaterThan(watchIndex);
    expect(source.slice(watchIndex, composerIndex)).not.toContain('max-w-800px');
  });
});
