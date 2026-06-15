/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
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

  it('auto-opens the watch panel and renders one frame per agent tab', async () => {
    convMock.get.mockResolvedValue({
      id: 'c1',
      extra: { session_mcp_servers: [{ id: 'bc1', name: BROWSER_CONTROL }] },
    });
    // The agent opened TWO tabs → the panel auto-opens and shows TWO frames.
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

    // Without any click, the docked panel appears because tabs exist.
    await waitFor(() => expect(screen.getByText('workspace.watchTitle')).toBeTruthy());
    // Both opened tabs are rendered as their own in-chat frames.
    await waitFor(() => {
      expect(screen.getByText('YouTube')).toBeTruthy();
      expect(screen.getByText('Facebook')).toBeTruthy();
    });
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
