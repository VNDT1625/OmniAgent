/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const buildProviderMock = vi.fn(() => ({ invoke: invokeMock }));

vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: buildProviderMock,
  },
}));

const importClient = async () => {
  vi.resetModules();
  return import('@/process/editor/editorToolsClient');
};

describe('editorToolsClient', () => {
  afterEach(() => {
    invokeMock.mockReset();
    buildProviderMock.mockClear();
    vi.useRealTimers();
  });

  it('returns a not-ready result when the renderer provider does not answer', async () => {
    vi.useFakeTimers();
    invokeMock.mockReturnValueOnce(new Promise(() => {}));
    const { runEditorTool } = await importClient();

    const pending = runEditorTool('/tmp/a.docx', { tool: 'read_document' });
    const assertion = expect(pending).resolves.toEqual({
      ok: false,
      reason: 'not-ready',
      error:
        'The Studio editor is not available (no editor window is open). Open the document in the Studio editor first.',
    });

    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });

  it('returns an error result when the renderer provider rejects', async () => {
    invokeMock.mockRejectedValueOnce(new Error('bridge failed'));
    const { runEditorTool } = await importClient();

    await expect(runEditorTool('/tmp/a.docx', { tool: 'read_document' })).resolves.toEqual({
      ok: false,
      reason: 'error',
      error: 'bridge failed',
    });
  });
});
