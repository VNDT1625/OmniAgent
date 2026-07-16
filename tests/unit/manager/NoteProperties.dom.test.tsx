/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for the Notion-style note properties block (Manager → Notes).
 *
 * Focus: the fixed "open source" behaviour for Data library entries.
 * - A Data entry with only a `filePath` opens via `ipcBridge.shell.openFile`
 *   (previously this silently did nothing — the bug we fixed).
 * - A Data entry with a `url` opens via `openExternalUrl` (system browser),
 *   never the renderer's `window.open`.
 *
 * The component renders Arco controls; the bridge + platform helpers are mocked
 * so we assert the call routing without real IPC.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from '@arco-design/web-react';
import { emptyManagerData, type ManagerData, type Note } from '@/process/manager/managerTypes';
import type { UseManagerStore } from '@/renderer/pages/manager/useManagerStore';

// i18n: identity translator so we can assert on raw keys / aria-labels.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

// Mock the shell bridge + external-open helper to capture routing.
const openFile = vi.hoisted(() => vi.fn(async () => undefined));
const openExternalUrl = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/common', () => ({ ipcBridge: { shell: { openFile: { invoke: openFile } } } }));
vi.mock('@/renderer/utils/platform', () => ({ openExternalUrl }));

import NoteProperties from '@/renderer/pages/manager/notes/editor/NoteProperties';

const baseNote = (over: Partial<Note>): Note => ({
  id: 'n1',
  category: 'data',
  body: '',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const makeStore = (note: Note): UseManagerStore => {
  const data: ManagerData = { ...emptyManagerData(), notes: [note] };
  return {
    data,
    status: 'ready',
    reload: vi.fn(),
    client: {} as UseManagerStore['client'],
    run: vi.fn(async () => true),
    mutate: vi.fn(async () => data),
  };
};

const renderProps = (note: Note) =>
  render(
    <ConfigProvider>
      <NoteProperties note={note} store={makeStore(note)} category='data' />
    </ConfigProvider>
  );

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('NoteProperties — Data open source', () => {
  it('opens a file-path entry through the shell bridge', async () => {
    const user = userEvent.setup();
    renderProps(baseNote({ filePath: 'C:\\docs\\calc.pdf', url: null }));

    await user.click(screen.getByLabelText('manager.notes.data.open'));

    expect(openFile).toHaveBeenCalledWith('C:\\docs\\calc.pdf');
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('opens a URL entry through the system browser helper', async () => {
    const user = userEvent.setup();
    renderProps(baseNote({ url: 'https://example.com/paper', filePath: null }));

    await user.click(screen.getByLabelText('manager.notes.data.open'));

    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/paper');
    expect(openFile).not.toHaveBeenCalled();
  });

  it('hides the open action when there is no source', () => {
    renderProps(baseNote({ url: null, filePath: null }));
    expect(screen.queryByLabelText('manager.notes.data.open')).toBeNull();
  });
});
