import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigProvider } from '@arco-design/web-react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mocks = vi.hoisted(() => ({
  sessions: vi.fn(),
  snapshot: vi.fn(),
  inspect: vi.fn(),
  worklog: vi.fn(),
  stop: vi.fn(),
  updateQueue: vi.fn(),
  removeQueue: vi.fn(),
  reorderQueue: vi.fn(),
}));

vi.mock('@/renderer/services/agentMeshClient', () => ({
  agentMeshClient: mocks,
}));

import AgentMeshInlineCard from '@/renderer/pages/conversation/components/superWatch/AgentMeshInlineCard';

const snapshot = {
  sessionId: 'conversation-1',
  agents: [{ agentId: 'leader' }, { agentId: 'worker', parentAgentId: 'leader' }],
  inspections: [
    { agent: { agentId: 'leader' }, status: 'idle', actionHistory: [], queue: [], stuck: false },
    {
      agent: { agentId: 'worker', parentAgentId: 'leader' },
      task: { taskId: 'task-1', agentId: 'worker', objective: 'Review the patch' },
      status: 'working',
      actionHistory: [],
      queue: [],
      stuck: false,
    },
  ],
  tasks: [],
  tokenUsage: { spentTokens: 10, reservedTokens: 5 },
};

const renderCard = () =>
  render(
    <ConfigProvider>
      <AgentMeshInlineCard conversationId='conversation-1' />
    </ConfigProvider>
  );

beforeEach(() => {
  mocks.sessions.mockResolvedValue(['conversation-1']);
  mocks.snapshot.mockResolvedValue({ ok: true, data: snapshot });
  mocks.inspect.mockResolvedValue({ ok: true, data: snapshot.inspections[1] });
  mocks.worklog.mockResolvedValue({ ok: true, data: [] });
  mocks.stop.mockResolvedValue({ ok: true, data: undefined });
  mocks.updateQueue.mockResolvedValue({ ok: true, data: undefined });
  mocks.removeQueue.mockResolvedValue({ ok: true, data: undefined });
  mocks.reorderQueue.mockResolvedValue({ ok: true, data: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AgentMeshInlineCard', () => {
  it('stays invisible when the conversation has no mesh session', async () => {
    mocks.sessions.mockResolvedValue([]);
    renderCard();

    await waitFor(() => expect(mocks.sessions).toHaveBeenCalled());
    expect(screen.queryByTestId('agent-mesh-inline-card')).not.toBeInTheDocument();
  });

  it('selects the newest active mesh when several conversations are running', async () => {
    mocks.sessions.mockResolvedValue(['older-session', 'newer-session']);
    mocks.snapshot.mockResolvedValue({ ok: true, data: snapshot });
    renderCard();

    expect(await screen.findByTestId('agent-mesh-inline-card')).toBeInTheDocument();
    expect(mocks.snapshot).toHaveBeenCalledWith('newer-session');
    expect(mocks.snapshot).not.toHaveBeenCalledWith('older-session');
  });

  it('shows a compact summary and inspects one agent without opening another chat panel', async () => {
    renderCard();

    expect(await screen.findByTestId('agent-mesh-inline-card')).toBeInTheDocument();
    fireEvent.click(screen.getByText('ide.agentMesh.inspect'));

    expect(await screen.findByText('Review the patch')).toBeInTheDocument();
    expect(mocks.inspect).toHaveBeenCalledWith({ sessionId: 'conversation-1', agentId: 'worker' });
  });

  it('lets the leader interrupt the active worker task', async () => {
    renderCard();
    fireEvent.click(await screen.findByText('ide.agentMesh.inspect'));
    fireEvent.click(await screen.findByText('ide.agentMesh.stopNow'));

    await waitFor(() =>
      expect(mocks.stop).toHaveBeenCalledWith({
        sessionId: 'conversation-1',
        actorId: 'leader',
        taskId: 'task-1',
        mode: 'interrupt',
      })
    );
  });
});
