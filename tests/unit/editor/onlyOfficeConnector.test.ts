/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  insertText,
  registerConnector,
  runOfficeScript,
  unregisterConnector,
  type OnlyOfficeConnector,
} from '@/renderer/pages/editor/adapters/onlyOfficeConnector';

const filePath = '/tmp/stalled.docx';

const makeConnector = (overrides: Partial<OnlyOfficeConnector> = {}): OnlyOfficeConnector => ({
  callCommand: vi.fn((_commandFn, callback) => callback?.('ok')),
  executeMethod: vi.fn((_name, _args, callback) => callback?.('ok')),
  disconnect: vi.fn(),
  ...overrides,
});

describe('onlyOfficeConnector timeout handling', () => {
  afterEach(() => {
    unregisterConnector(filePath);
    vi.useRealTimers();
  });

  it('rejects when a callCommand operation never invokes its callback', async () => {
    vi.useFakeTimers();
    registerConnector(
      filePath,
      makeConnector({
        callCommand: vi.fn(() => undefined),
      }),
      'word'
    );

    const pending = runOfficeScript(filePath, "return 'ok';");
    const assertion = expect(pending).rejects.toThrow(/Office editor command timed out after 12s/i);

    await vi.advanceTimersByTimeAsync(12000);
    await assertion;
  });

  it('rejects when an executeMethod operation never invokes its callback', async () => {
    vi.useFakeTimers();
    registerConnector(
      filePath,
      makeConnector({
        executeMethod: vi.fn(() => undefined),
      }),
      'word'
    );

    const pending = insertText(filePath, 'hello');
    const assertion = expect(pending).rejects.toThrow(/Office editor method "PasteText" timed out after 12s/i);

    await vi.advanceTimersByTimeAsync(12000);
    await assertion;
  });
});
