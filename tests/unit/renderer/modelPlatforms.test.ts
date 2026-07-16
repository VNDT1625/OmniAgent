/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { detectNewApiProtocol, getPlatformByValue } from '@/renderer/utils/model/modelPlatforms';

vi.mock('@/renderer/utils/platform', () => ({
  resolveBackendAssetUrl: (path: string) => path,
}));

describe('modelPlatforms', () => {
  it('registers 9Router as a new-api gateway with skipProtocolDetection so all models use OpenAI protocol', () => {
    const platform = getPlatformByValue('9router');

    expect(platform).toMatchObject({
      name: '9Router',
      value: '9router',
      platform: 'new-api',
      base_url: 'http://127.0.0.1:20128/v1',
      skipProtocolDetection: true,
    });
  });

  it('detects Anthropic protocol for prefixed 9Router Claude model ids', () => {
    // detectNewApiProtocol still detects based on name, but UI skips it for 9Router
    expect(detectNewApiProtocol('freemodel/claude-opus-4-8')).toBe('anthropic');
    expect(detectNewApiProtocol('kr/claude-sonnet-4.5')).toBe('anthropic');
  });
});
