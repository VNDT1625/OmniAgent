/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for the React Flow-based Automation `WorkflowEditor`. Verifies the
 * palette renders one entry per node kind, adding a step marks the editor dirty
 * and enables Save, and that Save persists the nodes as a LINEAR pipeline
 * ordered by vertical (Y) position — the backend contract the engine relies on.
 *
 * React Flow is exercised through `useNodesState`; ResizeObserver is stubbed by
 * the shared DOM setup so the canvas mounts without layout measurement.
 */

import { ConfigProvider } from '@arco-design/web-react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { count?: number }) => (opts && typeof opts.count === 'number' ? `${k}:${opts.count}` : k),
    i18n: { language: 'en' },
  }),
}));

vi.mock('@renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'light' }),
}));

// Arco's `Message` uses the legacy `ReactDOM.render` removed in React 19, which
// throws in jsdom. Stub it so the save toast does not raise an unhandled error.
vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return { ...actual, Message: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() } };
});

// NodeConfigForm pulls the model provider list; stub it so no agent IPC is needed.
vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useModelProviderList: () => ({ providers: [], getAvailableModels: () => [] as string[] }),
}));

import WorkflowEditor from '@/renderer/pages/studio/automation/components/WorkflowEditor';
import type { Workflow } from '@/renderer/pages/studio/automation/automationClient';

const baseWorkflow: Workflow = {
  id: 'wf-1',
  name: 'My Flow',
  nodes: [
    { id: 'a', kind: 'trigger.manual', name: 'Start', config: {} },
    { id: 'b', kind: 'action.log', name: 'Log it', config: { label: 'x' } },
  ],
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
};

const renderEditor = (onSave = vi.fn(async () => baseWorkflow)) => {
  render(
    <ConfigProvider>
      <WorkflowEditor workflow={baseWorkflow} onSave={onSave} />
    </ConfigProvider>
  );
  return { onSave };
};

afterEach(() => cleanup());

describe('WorkflowEditor (React Flow)', () => {
  it('renders the palette with one entry per node kind', () => {
    renderEditor();
    expect(screen.getByText('automation.editor.addStep')).toBeInTheDocument();
    // Palette labels (kind labels appear in the palette as add buttons).
    expect(screen.getAllByText('automation.node.http').length).toBeGreaterThan(0);
    expect(screen.getAllByText('automation.node.ai').length).toBeGreaterThan(0);
  });

  it('keeps Save disabled until an edit makes the editor dirty', () => {
    renderEditor();
    const save = screen.getByText('automation.editor.save').closest('button');
    expect(save).toBeDisabled();
  });

  it('adds a step and persists nodes ordered by Y position on save', async () => {
    const { onSave } = renderEditor();

    // Add an HTTP step from the palette.
    fireEvent.click(screen.getAllByText('automation.node.http')[0]);

    const save = screen.getByText('automation.editor.save').closest('button');
    await waitFor(() => expect(save).not.toBeDisabled());

    fireEvent.click(save as HTMLButtonElement);

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const arg = onSave.mock.calls[0][0] as {
      id?: string;
      name: string;
      nodes: Array<{ id: string; kind: string }>;
      enabled: boolean;
    };
    expect(arg.id).toBe('wf-1');
    expect(arg.name).toBe('My Flow');
    expect(arg.enabled).toBe(true);
    // Original two nodes plus the newly added one, preserved in top-to-bottom order.
    expect(arg.nodes.map((n) => n.kind)).toEqual(['trigger.manual', 'action.log', 'action.http']);
  });
});
