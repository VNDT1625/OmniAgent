/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for the Company Manager popup (Requirement 3 "Phần 2": boss ↔
 * employee dialogue, status board, permission approval).
 *
 * The real {@link useCompanyConversation} hook runs against a mocked
 * `companyBridgeClient`, so starting a run genuinely round-trips through the
 * client stub and the streamed events (pushed via the captured
 * `onCompanyConversationEvent` listener) drive the board / transcript /
 * permission UI exactly as in production.
 */

import type { ConversationEvent } from '@/process/company/companyConversation';
import type { CompanyStructure } from '@/process/company/companyOrchestrator';
import { ConfigProvider } from '@arco-design/web-react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- i18n: identity translator so assertions can use raw key strings ---------
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

// --- Arco Message: stub the toast API ----------------------------------------
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...actual, Message: { ...actual.Message, info: vi.fn(), success: vi.fn(), error: vi.fn() } };
});

// --- Company bridge client: configurable stubs + a captured event listener ----
const clientMocks = vi.hoisted(() => ({
  runConversation: vi.fn(),
  resolvePermission: vi.fn(),
  cancelConversation: vi.fn(),
  listeners: [] as Array<(envelope: { event: ConversationEvent }) => void>,
}));

vi.mock('@/renderer/pages/company/companyBridgeClient', () => ({
  companyClient: {
    runConversation: { invoke: clientMocks.runConversation },
    resolvePermission: { invoke: clientMocks.resolvePermission },
    cancelConversation: { invoke: clientMocks.cancelConversation },
  },
  onCompanyConversationEvent: (listener: (envelope: { event: ConversationEvent }) => void) => {
    clientMocks.listeners.push(listener);
    return () => {
      clientMocks.listeners = clientMocks.listeners.filter((l) => l !== listener);
    };
  },
}));

import ManagerPopup from '@/renderer/pages/company/manager/ManagerPopup';
import { resetCompanyConversationSessions } from '@/renderer/pages/company/useCompanyConversation';

/** Push a streamed conversation event to every subscribed listener. */
const emit = (event: ConversationEvent): void => {
  act(() => {
    for (const l of clientMocks.listeners) l({ event });
  });
};

const STRUCTURE: CompanyStructure = {
  companyId: 'co',
  root: {
    id: 'co:president',
    role: 'president',
    name: 'President',
    children: [{ id: 'co:head:0', role: 'division-head', name: 'Alice', divisionId: 'd0', children: [] }],
  },
};

const PARTICIPANTS = [
  { id: 'co:president', name: 'President', role: 'president' as const },
  { id: 'co:head:0', name: 'Alice', role: 'division-head' as const },
];

const renderPopup = async () => {
  const result = render(
    <ConfigProvider>
      <ManagerPopup visible onClose={() => {}} companyId='co' structure={STRUCTURE} />
    </ConfigProvider>
  );
  // The popup defaults to Pipeline mode; these tests exercise the Conversation
  // (quick model-chat) engine, so switch to it first.
  await userEvent.click(await screen.findByText('company.pipeline.modeConversation'));
  return result;
};

describe('ManagerPopup — company conversation surface (Requirement 3)', () => {
  beforeEach(() => {
    resetCompanyConversationSessions();
    clientMocks.runConversation.mockReset();
    clientMocks.resolvePermission.mockReset();
    clientMocks.cancelConversation.mockReset();
    clientMocks.listeners = [];
    clientMocks.runConversation.mockResolvedValue({ ok: true, data: { runId: 'r1', summary: '', status: 'done' } });
    clientMocks.resolvePermission.mockResolvedValue({ ok: true, data: { resolved: true } });
    clientMocks.cancelConversation.mockResolvedValue({ ok: true, data: undefined });
  });

  afterEach(() => cleanup());

  it('renders the manager title, goal composer and empty board/transcript hints', async () => {
    await renderPopup();
    expect(await screen.findByText('company.conversation.managerTitle')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('company.conversation.goalPlaceholder')).toBeInTheDocument();
    expect(screen.getByText('company.conversation.boardEmpty')).toBeInTheDocument();
    expect(screen.getByText('company.conversation.transcriptEmpty')).toBeInTheDocument();
  });

  it('starting a conversation calls runConversation with the typed goal', async () => {
    const user = userEvent.setup();
    await renderPopup();

    await user.type(screen.getByPlaceholderText('company.conversation.goalPlaceholder'), 'Ship it');
    await user.click(screen.getByText('company.conversation.start'));

    await waitFor(() =>
      expect(clientMocks.runConversation).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: 'co', goal: 'Ship it' })
      )
    );
  });

  it('renders the status board roster and a directive/report transcript from streamed events', async () => {
    await renderPopup();

    emit({ type: 'run-started', runId: 'r1', goal: 'g', participants: PARTICIPANTS });
    // Both participants appear on the board.
    expect(await screen.findByText('President')).toBeInTheDocument();
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0);

    emit({
      type: 'message',
      runId: 'r1',
      message: {
        id: 'm1',
        fromId: 'co:president',
        toId: 'co:head:0',
        content: 'Build the UI',
        at: 1,
        kind: 'directive',
      },
    });
    emit({
      type: 'message',
      runId: 'r1',
      message: { id: 'm2', fromId: 'co:head:0', toId: 'co:president', content: 'UI is done', at: 2, kind: 'report' },
    });

    expect(await screen.findByText('Build the UI')).toBeInTheDocument();
    expect(screen.getByText('UI is done')).toBeInTheDocument();
  });

  it('surfaces a permission request and approving it calls resolvePermission with approved=true', async () => {
    const user = userEvent.setup();
    await renderPopup();

    emit({ type: 'run-started', runId: 'r1', goal: 'g', participants: PARTICIPANTS });
    emit({
      type: 'permission',
      runId: 'r1',
      request: { id: 'p1', fromId: 'co:head:0', action: 'deploy to prod', reason: 'release', at: 1 },
    });

    expect(await screen.findByText('deploy to prod')).toBeInTheDocument();
    await user.click(screen.getByText('company.conversation.permission.approve'));

    await waitFor(() =>
      expect(clientMocks.resolvePermission).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'p1', approved: true })
      )
    );
  });

  it('shows the President summary when the run finishes', async () => {
    await renderPopup();
    emit({ type: 'run-started', runId: 'r1', goal: 'g', participants: PARTICIPANTS });
    emit({ type: 'run-finished', runId: 'r1', summary: 'We will deliver the app.', status: 'done' });

    expect(await screen.findByText('We will deliver the app.')).toBeInTheDocument();
  });

  it('renders an error banner when the run errors', async () => {
    await renderPopup();
    emit({ type: 'run-started', runId: 'r1', goal: 'g', participants: PARTICIPANTS });
    emit({ type: 'run-error', runId: 'r1', message: 'No usable model is configured.' });

    expect(await screen.findByText('No usable model is configured.')).toBeInTheDocument();
  });
});
