/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { withCoreTimeout } from '../../../packages/desktop/src/renderer/pages/testing/coreChatClient';

describe('coreChatClient timeout', () => {
  afterEach(() => vi.useRealTimers());

  it('rejects when an unwired Main-process bridge never answers', async () => {
    vi.useFakeTimers();
    const pending = withCoreTimeout(new Promise<never>(() => {}), 'listTargets', 100);
    const assertion = expect(pending).rejects.toThrow('experimental core bridge');

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });
});
