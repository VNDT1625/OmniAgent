/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for WorkspaceSurfaces — the embeddable composer + parallel-frame
 * grid that runs several sub-agents at once inside a conversation.
 *
 * The real `useWorkspaceRun` hook runs against a mocked `workspaceBridgeClient`
 * (no IPC); the live `workspace.event` stream is driven by the test. Assertions:
 *  - running an instruction calls the bridge `run` with parsed surface specs;
 *  - the host conversation's model is used as the default (no manual pick);
 *  - streamed `surface-created` events render one frame per surface.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from '@arco-design/web-react';
import type { WorkspaceEvent } from '@/process/workspace/surfaceTypes';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useModelProviderList: () => ({
    providers: [{ id: 'p1', models: ['gpt-test'] }],
    getAvailableModels: () => ['gpt-test'],
    formatModelLabel: (_p: unknown, m?: string) => m ?? '',
  }),
}));

// Editor/browser surface bodies pull in heavy/native code — stub them out.
vi.mock('@/renderer/pages/workspace/components/EditorSurfaceView', () => ({
  default: () => <div data-testid='editor-surface' />,
}));
vi.mock('@/renderer/pages/workspace/components/BrowserSurfaceView', () => ({
  default: () => <div data-testid='browser-surface' />,
}));

const bridgeMocks = vi.hoisted(() => {
  let listener: ((e: WorkspaceEvent) => void) | null = null;
  return {
    run: vi.fn(() => Promise.resolve({ surfaces: [], ok: true })),
    cancel: vi.fn(() => Promise.resolve()),
    onEvent: vi.fn((cb: (e: WorkspaceEvent) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
    emit: (e: WorkspaceEvent) => listener?.(e),
  };
});

vi.mock('@/renderer/pages/workspace/workspaceBridgeClient', () => ({
  workspaceClient: { run: bridgeMocks.run, cancel: bridgeMocks.cancel, onEvent: bridgeMocks.onEvent },
}));

import WorkspaceSurfaces from '@/renderer/pages/workspace/WorkspaceSurfaces';

const renderPanel = (defaultModel?: string | null) =>
  render(
    <ConfigProvider>
      <WorkspaceSurfaces defaultModel={defaultModel} />
    </ConfigProvider>
  );

describe('WorkspaceSurfaces (DOM)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });
  afterEach(() => cleanup());

  it('renders the composer and the empty state', () => {
    renderPanel('gpt-test');
    expect(screen.getByText('workspace.empty')).toBeTruthy();
  });

  it('runs the instruction with parsed surface specs using the conversation model', async () => {
    const user = userEvent.setup();
    // defaultModel seeds the composer so no manual model pick is needed.
    renderPanel('gpt-test');

    const textbox = screen.getByPlaceholderText('workspace.composer.placeholder');
    await user.type(textbox, 'search jobs on glassdoor.com and edit notes.md');

    const runBtn = screen.getByText('workspace.composer.run');
    await user.click(runBtn.closest('button')!);

    await waitFor(() => expect(bridgeMocks.run).toHaveBeenCalledTimes(1));
    const arg = bridgeMocks.run.mock.calls[0][0] as { surfaces: Array<{ kind: string; model: string }> };
    expect(arg.surfaces.map((s) => s.kind).toSorted()).toEqual(['browser', 'editor']);
    expect(arg.surfaces.every((s) => s.model === 'gpt-test')).toBe(true);
  });

  it('renders one frame per streamed surface-created event', async () => {
    renderPanel('gpt-test');
    bridgeMocks.emit({
      type: 'surface-created',
      surface: { id: 's1', kind: 'editor', title: 'notes.md', status: 'running', steps: 0, filePath: 'notes.md' },
    });
    bridgeMocks.emit({
      type: 'surface-created',
      surface: { id: 's2', kind: 'browser', title: 'glassdoor.com', status: 'running', steps: 0, tabId: 'tab' },
    });
    await waitFor(() => {
      expect(screen.getByText('notes.md')).toBeTruthy();
      expect(screen.getByText('glassdoor.com')).toBeTruthy();
    });
  });
});
