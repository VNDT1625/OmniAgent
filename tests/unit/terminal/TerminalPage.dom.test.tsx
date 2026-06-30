/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for the Terminal manager page (Settings › Terminal).
 *
 * The real `useTerminalState` hook runs against a mocked `terminalBridgeClient`
 * (no IPC), so the page genuinely round-trips through the client stubs. Covers:
 * the running-count surface, creating a session, killing a session, the
 * read-only system view, and the bridge-unavailable fallback.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from '@arco-design/web-react';
import type { TerminalSession } from '@/process/terminal/terminalTypes';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...actual, Message: { ...actual.Message, success: vi.fn(), error: vi.fn() } };
});

vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true }));

const session = (over?: Partial<TerminalSession>): TerminalSession => ({
  id: 's1',
  title: 'bash 1',
  shell: '/bin/bash',
  cwd: '/home/me',
  status: 'running',
  createdAt: 0,
  exitedAt: null,
  exitCode: null,
  pid: 4242,
  scheduled: false,
  ...over,
});

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  kill: vi.fn(),
  remove: vi.fn(),
  write: vi.fn(),
  scrollback: vi.fn(),
  listSystem: vi.fn(),
  listShells: vi.fn(),
  listSchedules: vi.fn(),
  saveSchedule: vi.fn(),
  removeSchedule: vi.fn(),
  runScheduleNow: vi.fn(),
  onData: vi.fn(() => () => {}),
  onExit: vi.fn(() => () => {}),
  onSessionsChanged: vi.fn(() => () => {}),
  onSchedulesChanged: vi.fn(() => () => {}),
}));

vi.mock('@/renderer/pages/terminal/terminalBridgeClient', () => ({
  terminalClient: mocks,
}));

import TerminalPage from '@/renderer/pages/terminal/TerminalPage';

let sessionsChangedListener: ((sessions: TerminalSession[]) => void) | null = null;

const renderPage = () =>
  render(
    <ConfigProvider>
      <TerminalPage />
    </ConfigProvider>
  );

beforeEach(() => {
  for (const fn of Object.values(mocks)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  mocks.onData.mockReturnValue(() => {});
  mocks.onExit.mockReturnValue(() => {});
  sessionsChangedListener = null;
  mocks.onSessionsChanged.mockImplementation((listener) => ((sessionsChangedListener = listener), () => {}));
  mocks.onSchedulesChanged.mockReturnValue(() => {});
  mocks.list.mockResolvedValue({ ok: true, data: { sessions: [session()], runningCount: 1 } });
  mocks.scrollback.mockResolvedValue({ ok: true, data: 'welcome\n' });
  mocks.listSystem.mockResolvedValue({ ok: true, data: [{ pid: 10, name: 'cmd.exe' }] });
  mocks.listShells.mockResolvedValue({ ok: true, data: [] });
  mocks.listSchedules.mockResolvedValue({ ok: true, data: [] });
  mocks.create.mockResolvedValue({ ok: true, data: session({ id: 's2', title: 'bash 2' }) });
  mocks.kill.mockResolvedValue({ ok: true, data: undefined });
});

afterEach(() => cleanup());

describe('TerminalPage', () => {
  it('shows the running-session count from the bridge', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('terminal.runningCount')).toBeInTheDocument());
    expect(mocks.list).toHaveBeenCalled();
  });

  it('lists the active session and replays its scrollback buffer', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText('bash 1').length).toBeGreaterThan(0));
    // The scrollback is replayed into the xterm.js emulator (which renders into
    // its own canvas/cell grid, not the DOM text tree), so assert the replay
    // mechanism — the session's scrollback was fetched through the bridge.
    await waitFor(() => expect(mocks.scrollback).toHaveBeenCalledWith({ id: 's1' }));
  });

  it('hydrates scrollback for sessions announced after the initial load', async () => {
    renderPage();
    await waitFor(() => expect(mocks.scrollback).toHaveBeenCalledWith({ id: 's1' }));
    mocks.scrollback.mockClear();

    act(() => {
      sessionsChangedListener?.([session(), session({ id: 's2', title: 'bash 2', pid: 4243 })]);
    });

    await waitFor(() => expect(mocks.scrollback).toHaveBeenCalledWith({ id: 's2' }));
  });

  it('surfaces MTUI stale-edit confirmations from terminal output', async () => {
    mocks.scrollback.mockResolvedValueOnce({
      ok: true,
      data: JSON.stringify({
        ok: false,
        details: {
          resolution: {
            status: 'needs_confirmation',
            confirmation_token: 'token-1',
          },
          checked_operations: [{ diff_excerpt: '+ return bar() + 1;' }],
        },
      }),
    });

    renderPage();

    await waitFor(() => expect(screen.getByText('terminal.view.mtuiConflictTitle')).toBeInTheDocument());
    expect(screen.getByText('+ return bar() + 1;')).toBeInTheDocument();
  });

  it('creates a new session when the New button is clicked', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByText('bash 1').length).toBeGreaterThan(0));

    await user.click(screen.getByLabelText('terminal.sessions.new'));

    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
  });

  it('kills a running session through the bridge', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByText('bash 1').length).toBeGreaterThan(0));

    await user.click(screen.getByLabelText('terminal.sessions.kill'));

    await waitFor(() => expect(mocks.kill).toHaveBeenCalledWith({ id: 's1' }));
  });

  it('falls back to the bridge notice when the first probe fails', async () => {
    mocks.list.mockRejectedValueOnce(new Error('not wired'));
    renderPage();
    await waitFor(() => expect(screen.getByText('terminal.bridgeUnavailable')).toBeInTheDocument());
    expect(screen.getByText('terminal.retry')).toBeInTheDocument();
  });
});
