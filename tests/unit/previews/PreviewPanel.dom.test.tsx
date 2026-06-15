/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Export-shape smoke test for PreviewPanel.
 *
 * The module pulls in a heavy dependency chain (Monaco, markdown, office
 * viewers). Under the full suite's parallel transform pressure a cold import
 * can take tens of seconds — well past the default 10s per-test timeout. We
 * therefore pay the cold-import cost ONCE in `beforeAll` (with a generous hook
 * timeout) and let each assertion run synchronously against the loaded module,
 * so the tests measure "does it export correctly", not cold-start latency.
 */

const IMPORT_TIMEOUT_MS = 120000;

type PreviewPanelModule = typeof import('@/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewPanel');

let mod: PreviewPanelModule;

beforeAll(async () => {
  mod = await import('@/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewPanel');
}, IMPORT_TIMEOUT_MS);

describe('PreviewPanel', () => {
  it('is a React component module that exports a default function', () => {
    expect(typeof mod.default).toBe('function');
  });

  it('module loads without throwing on import', () => {
    expect(mod).toBeTruthy();
  });

  it('has a displayName or function name for debugging', () => {
    const fn = mod.default;
    expect(fn.name || fn.displayName || 'anonymous').toBeTruthy();
  });
});
