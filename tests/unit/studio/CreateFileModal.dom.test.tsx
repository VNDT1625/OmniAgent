/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for the Studio create-file modal. Verifies the empty/generate mode
 * switch, that "Generate with AI" reveals the content-agent panel (model +
 * description + references), and that picking a directory + creating forwards
 * the written path. The fs/dialog/chat bridges are mocked so no IPC is needed.
 */

import { ConfigProvider } from '@arco-design/web-react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

const showOpen = vi.fn(
  async (req: { properties?: string[] }) =>
    (req.properties?.includes('openDirectory') ? ['/dir'] : ['/ref.txt']) as string[] | undefined
);
const writeFile = vi.fn(async () => true);
const chat = vi.fn(async () => ({ ok: true, data: 'generated body' }));

vi.mock('@/common', () => ({
  ipcBridge: {
    dialog: { showOpen: { invoke: (req: { properties?: string[] }) => showOpen(req) } },
    fs: { writeFile: { invoke: (...a: unknown[]) => writeFile(...a) }, readFile: { invoke: vi.fn(async () => '') } },
  },
}));

vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useModelProviderList: () => ({
    providers: [{ id: 'p1', models: ['gpt-x'] }],
    getAvailableModels: () => ['gpt-x'],
    formatModelLabel: () => '',
  }),
}));

vi.mock('@/renderer/pages/studio/studioChatClient', () => ({
  studioChatClient: { chat: { invoke: (...a: unknown[]) => chat(...a) } },
}));

import CreateFileModal from '@/renderer/pages/studio/components/CreateFileModal';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k) : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  showOpen.mockClear();
  writeFile.mockClear();
  chat.mockClear();
});
afterEach(() => cleanup());

const setup = (onCreated = vi.fn()) => {
  render(
    <ConfigProvider>
      <CreateFileModal visible onCancel={vi.fn()} onCreated={onCreated} />
    </ConfigProvider>
  );
  return { onCreated };
};

describe('CreateFileModal', () => {
  it('creates an empty file and forwards the written path', async () => {
    const { onCreated } = setup();
    const input = screen.getByPlaceholderText('studio.create.placeholder');
    fireEvent.change(input, { target: { value: 'notes.md' } });
    fireEvent.click(screen.getByText('studio.create.confirm'));

    await waitFor(() => expect(writeFile).toHaveBeenCalledWith({ path: '/dir/notes.md', data: '' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('/dir/notes.md'));
    expect(chat).not.toHaveBeenCalled();
  });

  it('reveals the content-agent panel in generate mode', () => {
    setup();
    fireEvent.change(screen.getByPlaceholderText('studio.create.placeholder'), { target: { value: 'plan.md' } });
    fireEvent.click(screen.getByText('studio.create.modeGenerate'));
    expect(screen.getByText('studio.create.agentTitle')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('studio.create.descriptionPlaceholder')).toBeInTheDocument();
  });

  it('generates content from a description and writes it', async () => {
    const { onCreated } = setup();
    fireEvent.change(screen.getByPlaceholderText('studio.create.placeholder'), { target: { value: 'plan.md' } });
    fireEvent.click(screen.getByText('studio.create.modeGenerate'));
    fireEvent.change(screen.getByPlaceholderText('studio.create.descriptionPlaceholder'), {
      target: { value: 'a weekly plan' },
    });
    fireEvent.click(screen.getByText('studio.create.generateConfirm'));

    await waitFor(() => expect(chat).toHaveBeenCalled());
    await waitFor(() => expect(writeFile).toHaveBeenCalledWith({ path: '/dir/plan.md', data: 'generated body' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('/dir/plan.md'));
  });
});
