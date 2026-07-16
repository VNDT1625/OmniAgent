/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for the Personal Manager page (Task 6.5).
 *
 * Covers:
 * - Renders the three tabs (Tasks / Notes / Schedule) when the bridge is ready.
 * - Creating a task manually round-trips through the client and updates the
 *   list (criterion 1.1) — driven via the real useManagerStore hook over a
 *   mocked client.
 * - Shows a friendly BridgeNotice (not a hang) when the bridge is unavailable
 *   (criterion 9.6).
 *
 * The real `useManagerStore` hook runs against a mocked `managerBridgeClient`
 * (no IPC), so the actions genuinely round-trip through the client stubs.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from '@arco-design/web-react';
import { emptyManagerData, type ManagerData, type Task } from '@/process/manager/managerTypes';

// --- i18n: identity translator so assertions can use raw key strings ---------
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

// --- Arco Message: stub toasts so no portal spawns during tests --------------
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return {
    ...actual,
    Message: { ...actual.Message, success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  };
});

// --- Manager IPC bridge client: configurable vi.fn() stubs (no real IPC) ------
const bridgeMocks = vi.hoisted(() => ({
  getData: vi.fn(),
  addTask: vi.fn(),
  updateTask: vi.fn(),
  removeTask: vi.fn(),
  toggleSubtask: vi.fn(),
  setTaskStatus: vi.fn(),
  addNote: vi.fn(),
  updateNote: vi.fn(),
  removeNote: vi.fn(),
  addEvent: vi.fn(),
  updateEvent: vi.fn(),
  removeEvent: vi.fn(),
  setEvents: vi.fn(),
  updateSettings: vi.fn(),
  snoozeReminder: vi.fn(),
  dismissReminder: vi.fn(),
  aiParseTasks: vi.fn(),
  aiReviewTasks: vi.fn(),
  aiParseSchedule: vi.fn(),
  aiParseImage: vi.fn(),
  aiOptimize: vi.fn(),
  onDataChanged: vi.fn(() => () => undefined),
}));

vi.mock('@/renderer/pages/manager/managerBridgeClient', () => ({
  managerClient: bridgeMocks,
}));

import ManagerPage from '@/renderer/pages/manager/ManagerPage';

const ok = <T,>(data: T) => ({ ok: true as const, data });

const renderPage = () =>
  render(
    <ConfigProvider>
      <ManagerPage />
    </ConfigProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  bridgeMocks.onDataChanged.mockImplementation(() => () => undefined);
});

afterEach(() => cleanup());

describe('ManagerPage', () => {
  it('renders the three tabs when the bridge is ready', async () => {
    bridgeMocks.getData.mockResolvedValue(ok(emptyManagerData()));
    renderPage();

    // The 2026 layout renders each destination label in the edge-docked nav,
    // and the active one also appears in the breadcrumb — so a label may occur
    // more than once. Assert each is present at least once (getAllByText).
    await waitFor(() => expect(screen.getAllByText('manager.tabs.tasks').length).toBeGreaterThan(0));
    expect(screen.getAllByText('manager.tabs.notes').length).toBeGreaterThan(0);
    expect(screen.getAllByText('manager.tabs.schedule').length).toBeGreaterThan(0);
  });

  it('shows a friendly notice (not a hang) when the bridge is unavailable', async () => {
    bridgeMocks.getData.mockRejectedValue(new Error('not wired'));
    renderPage();

    await waitFor(() => expect(screen.getByText('manager.bridgeUnavailable')).toBeTruthy());
    expect(screen.getByText('manager.retry')).toBeTruthy();
  });

  it('creates a task manually through the client', async () => {
    const user = userEvent.setup();
    bridgeMocks.getData.mockResolvedValue(ok(emptyManagerData()));

    // addTask returns the updated document containing the new task.
    const created: Task = {
      id: 't1',
      title: 'Buy milk',
      kind: 'oneoff',
      priority: 'medium',
      status: 'todo',
      tags: [],
      subtasks: [],
      reminders: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const withTask: ManagerData = { ...emptyManagerData(), tasks: [created] };
    bridgeMocks.addTask.mockResolvedValue(ok(withTask));

    renderPage();
    await waitFor(() => expect(screen.getByText('manager.tasks.create')).toBeTruthy());

    // Open the editor.
    await user.click(screen.getByText('manager.tasks.create'));
    await waitFor(() => expect(screen.getByText('manager.taskEditor.createTitle')).toBeTruthy());

    // Type a title (first textbox in the modal is the title input).
    const inputs = screen.getAllByRole('textbox');
    await user.type(inputs[0], 'Buy milk');

    // Save.
    await user.click(screen.getByText('manager.taskEditor.save'));

    await waitFor(() => expect(bridgeMocks.addTask).toHaveBeenCalled());
    const arg = bridgeMocks.addTask.mock.calls[0][0];
    expect(arg.input.title).toBe('Buy milk');

    // The new task shows in the list.
    await waitFor(() => expect(screen.getByText('Buy milk')).toBeTruthy());
  });
});
