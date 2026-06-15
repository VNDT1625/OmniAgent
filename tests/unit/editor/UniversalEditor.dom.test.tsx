/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for the Universal Editor frame (Task 8.3 / 8.12, Requirement 2a).
 *
 * Focus — criteria 2.1 / 2.9: the frame classifies a file via the registry and
 * renders the matching adapter, falling back to the raw-text editor when no
 * specific adapter applies (never stuck). The heavy adapters (Monaco, etc.) and
 * the fs data layer are mocked so the test exercises ONLY the selection logic.
 */

import { ConfigProvider } from '@arco-design/web-react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- i18n: identity translator so assertions can use raw key strings ---------
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

// --- The fs data layer: a deterministic, already-loaded file (no IPC) --------
const fileState = {
  content: 'hello',
  savedContent: 'hello',
  loading: false,
  saving: false,
  error: null as Error | null,
  dirty: false,
  setContent: vi.fn(),
  save: vi.fn(async () => undefined),
  reload: vi.fn(async () => undefined),
};
vi.mock('@/renderer/pages/editor/hooks/useEditorFile', () => ({
  useEditorFile: () => fileState,
}));

// --- Replace the lazy adapter registrations with cheap identifiable stubs.
//     Importing the editor module triggers `./adapters` (the real lazy imports);
//     we instead register synchronous markers so we can assert which kind was
//     chosen without loading Monaco/canvas/etc. -------------------------------
vi.mock('@/renderer/pages/editor/adapters', () => ({}));

import { registerEditorAdapter, type EditorAdapterProps } from '@/renderer/pages/editor/adapterRegistry';
import { UniversalEditor } from '@/renderer/pages/editor/UniversalEditor';

/** Build a trivial marker adapter that renders its kind label. */
const marker = (label: string): React.FC<EditorAdapterProps> => {
  const Comp: React.FC<EditorAdapterProps> = () => <div data-testid='adapter'>{label}</div>;
  return Comp;
};

// Register markers for the specific kinds (raw-text already has the inline fallback).
registerEditorAdapter('text-code', marker('text-code'));
registerEditorAdapter('pdf', marker('pdf'));
registerEditorAdapter('image', marker('image'));
registerEditorAdapter('binary-inspect', marker('binary-inspect'));

const renderEditor = (filePath: string) =>
  render(<ConfigProvider>{<UniversalEditor filePath={filePath} />}</ConfigProvider>);

describe('UniversalEditor adapter selection (Requirement 2a, criteria 2.1 / 2.9)', () => {
  beforeEach(() => {
    fileState.dirty = false;
    fileState.saving = false;
    fileState.error = null;
    fileState.save.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('selects the text-code adapter for a source file', async () => {
    renderEditor('main.ts');
    expect(await screen.findByTestId('adapter')).toHaveTextContent('text-code');
  });

  it('selects the pdf adapter for a .pdf file', async () => {
    renderEditor('report.pdf');
    expect(await screen.findByTestId('adapter')).toHaveTextContent('pdf');
  });

  it('selects the image adapter for a .png file', async () => {
    renderEditor('photo.png');
    expect(await screen.findByTestId('adapter')).toHaveTextContent('image');
  });

  it('selects the binary-inspect adapter for an archive (criterion 2.8)', async () => {
    renderEditor('bundle.zip');
    expect(await screen.findByTestId('adapter')).toHaveTextContent('binary-inspect');
  });

  it('autosaves dirty IDE buffers after the configured delay and reports success', async () => {
    vi.useFakeTimers();
    fileState.dirty = true;
    const onSaved = vi.fn();
    render(
      <ConfigProvider>
        <UniversalEditor filePath='main.ts' autoSaveDelayMs={1000} onSaved={onSaved} />
      </ConfigProvider>
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(fileState.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fileState.save).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith('main.ts');
  });

  it('falls back to the inline raw-text editor for an unknown extension (criterion 2.9)', async () => {
    renderEditor('mystery.zzz');
    // No marker adapter is registered for raw-text; the inline fallback renders a
    // textarea with the raw-text placeholder, never crashing / getting stuck.
    await waitFor(() => expect(screen.getByPlaceholderText('editor.rawText.placeholder')).toBeInTheDocument());
    expect(screen.queryByTestId('adapter')).not.toBeInTheDocument();
  });

  it('shows an error result with retry when the file fails to load', async () => {
    fileState.error = new Error('boom');
    renderEditor('main.ts');
    expect(await screen.findByText('editor.state.errorTitle')).toBeInTheDocument();
    expect(screen.getByText('editor.action.retry')).toBeInTheDocument();
    fileState.error = null; // reset for other tests
  });
});
