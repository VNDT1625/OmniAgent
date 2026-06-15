/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for the Manager popup's **Pipeline (real work)** mode (spec
 * agent-company-pipeline, Requirement 7).
 *
 * The real `useCompanyPipeline` hook + `pipelineStore` run against a mocked
 * `runCompany`, which captures the store passed in and lets the test drive the
 * event stream — so the recursive role-tree board, transcript, artifacts and
 * approval panel render exactly as in production.
 */

import type { CompanyStructure } from '@/process/company/companyOrchestrator';
import type { PipelineEvent } from '@/renderer/pages/company/pipeline/pipelineTypes';
import type { PipelineStore } from '@/renderer/pages/company/pipeline/pipelineStore';
import { ConfigProvider } from '@arco-design/web-react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...actual, Message: { ...actual.Message, info: vi.fn(), success: vi.fn(), error: vi.fn() } };
});

// Capture the store + the resolveApproval mock from runCompany.
const captured = vi.hoisted(() => ({ store: null as PipelineStore | null, resolveApproval: vi.fn(), stop: vi.fn() }));

vi.mock('@/renderer/pages/company/pipeline/companyPipeline', () => ({
  runCompany: (input: { store: PipelineStore }) => {
    captured.store = input.store;
    return { runId: 'r1', resolveApproval: captured.resolveApproval, stop: captured.stop, done: Promise.resolve() };
  },
}));

import ManagerPopup from '@/renderer/pages/company/manager/ManagerPopup';
import { resetCompanyPipelineSessions } from '@/renderer/pages/company/useCompanyPipeline';

/** Dispatch an event into the captured store inside act(). */
const emit = (event: PipelineEvent): void => {
  act(() => {
    captured.store?.dispatch(event);
  });
};

const STRUCTURE: CompanyStructure = {
  companyId: 'co',
  root: {
    id: 'co:president',
    role: 'president',
    name: 'President',
    children: [
      {
        id: 'co:head:a',
        role: 'division-head',
        name: 'Architect',
        children: [{ id: 'co:worker:c', role: 'worker', name: 'Dev', children: [] }],
      },
    ],
  },
};

const STATES = [
  { nodeId: 'co:president', name: 'President', role: 'president' as const, activity: 'idle' as const, updatedAt: 1 },
  {
    nodeId: 'co:head:a',
    name: 'Architect',
    role: 'division-head' as const,
    parentId: 'co:president',
    activity: 'idle' as const,
    updatedAt: 1,
  },
  {
    nodeId: 'co:worker:c',
    name: 'Dev',
    role: 'worker' as const,
    parentId: 'co:head:a',
    activity: 'idle' as const,
    updatedAt: 1,
  },
];

const renderPopup = () =>
  render(
    <ConfigProvider>
      <ManagerPopup
        visible
        onClose={() => {}}
        companyId='co'
        companyName='IT'
        rules={[]}
        structure={STRUCTURE}
        language='en'
      />
    </ConfigProvider>
  );

describe('ManagerPopup — Pipeline mode (Requirement 7)', () => {
  beforeEach(() => {
    resetCompanyPipelineSessions();
    captured.store = null;
    captured.resolveApproval.mockReset();
    captured.stop.mockReset();
  });
  afterEach(() => cleanup());

  it('defaults to Pipeline mode and shows the goal composer + empty tree hint', async () => {
    renderPopup();
    expect(await screen.findByText('company.conversation.managerTitle')).toBeInTheDocument();
    expect(screen.getByText('company.pipeline.modePipeline')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('company.conversation.goalPlaceholder')).toBeInTheDocument();
    expect(screen.getByText('company.pipeline.boardEmpty')).toBeInTheDocument();
  });

  it('starting a run renders the recursive role tree from streamed events', async () => {
    const user = userEvent.setup();
    renderPopup();

    await user.type(screen.getByPlaceholderText('company.conversation.goalPlaceholder'), 'Build the app');
    await user.click(screen.getByText('company.conversation.start'));

    // runCompany was called → store captured.
    await waitFor(() => expect(captured.store).not.toBeNull());

    emit({ type: 'run-started', runId: 'r1', rootId: 'co:president', states: STATES });

    // All three levels of the tree appear (President → Architect → Dev).
    expect(await screen.findByText('President')).toBeInTheDocument();
    expect(screen.getByText('Architect')).toBeInTheDocument();
    expect(screen.getByText('Dev')).toBeInTheDocument();
  });

  it('renders artifacts and a permission/approval that approves through the run handle', async () => {
    const user = userEvent.setup();
    renderPopup();
    await user.type(screen.getByPlaceholderText('company.conversation.goalPlaceholder'), 'Build the app');
    await user.click(screen.getByText('company.conversation.start'));
    await waitFor(() => expect(captured.store).not.toBeNull());

    emit({ type: 'run-started', runId: 'r1', rootId: 'co:president', states: STATES });
    emit({
      type: 'artifact',
      runId: 'r1',
      artifact: { id: 'a1', nodeId: 'co:head:a', kind: 'doc', title: 'C4 model', preview: 'context diagram', at: 2 },
    });
    emit({
      type: 'approval',
      runId: 'r1',
      request: { id: 'p1', fromId: 'co:head:a', gate: 'approval', summary: 'Approve the C4 model', at: 3 },
    });

    expect(await screen.findByText('C4 model')).toBeInTheDocument();
    expect(screen.getByText('Approve the C4 model')).toBeInTheDocument();

    await user.click(screen.getByText('company.conversation.permission.approve'));
    await waitFor(() =>
      expect(captured.resolveApproval).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'p1', approved: true })
      )
    );
  });

  it('switches to Conversation mode', async () => {
    const user = userEvent.setup();
    renderPopup();
    await user.click(screen.getByText('company.pipeline.modeConversation'));
    expect(screen.getByText('company.pipeline.modeConversationHint')).toBeInTheDocument();
  });
});
