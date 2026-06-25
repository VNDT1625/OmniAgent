/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/utils/deepLink — focuses on the URL parsing that now
 * also recognises http/https URLs handed to AionUi as the OS default browser
 * (mapped to the `open-url` action) alongside the existing aionui:// protocol.
 */

import { describe, it, expect, vi } from 'vitest';

// deepLink.ts imports `@/common` (ipcBridge) at module load. The parser itself
// is pure, so a minimal stub keeps the import side-effect-free for the test.
vi.mock('@/common', () => ({
  ipcBridge: {
    deepLink: { received: { emit: vi.fn() } },
  },
}));

import { parseDeepLinkUrl, isHandledUrlArg } from '@/process/utils/deepLink';

describe('parseDeepLinkUrl — web URLs (default-browser hand-off)', () => {
  it('maps an https URL to the open-url action with the url param', () => {
    const result = parseDeepLinkUrl('https://example.com/path?q=1');
    expect(result).toEqual({ action: 'open-url', params: { url: 'https://example.com/path?q=1' } });
  });

  it('maps an http URL to the open-url action', () => {
    const result = parseDeepLinkUrl('http://localhost:3000/');
    expect(result?.action).toBe('open-url');
    expect(result?.params.url).toBe('http://localhost:3000/');
  });
});

describe('parseDeepLinkUrl — aionui:// protocol (unchanged)', () => {
  it('parses the add-provider action with query params', () => {
    const result = parseDeepLinkUrl('aionui://add-provider?base_url=https://api.test&api_key=abc');
    expect(result).toEqual({
      action: 'add-provider',
      params: { base_url: 'https://api.test', api_key: 'abc' },
    });
  });

  it('decodes the base64 data param into params', () => {
    const data = Buffer.from(JSON.stringify({ base_url: 'https://x.test', api_key: 'k' }), 'utf-8').toString('base64');
    const result = parseDeepLinkUrl(`aionui://provider/add?v=1&data=${encodeURIComponent(data)}`);
    expect(result?.action).toBe('provider/add');
    expect(result?.params.base_url).toBe('https://x.test');
    expect(result?.params.api_key).toBe('k');
    expect(result?.params.data).toBeUndefined();
  });

  it('returns null for unrelated/invalid schemes', () => {
    expect(parseDeepLinkUrl('ftp://example.com')).toBeNull();
    expect(parseDeepLinkUrl('not a url')).toBeNull();
  });
});

describe('isHandledUrlArg', () => {
  it('recognises aionui:// and web URLs', () => {
    expect(isHandledUrlArg('aionui://add-provider')).toBe(true);
    expect(isHandledUrlArg('https://example.com')).toBe(true);
    expect(isHandledUrlArg('http://example.com')).toBe(true);
  });

  it('ignores plain CLI args and other schemes', () => {
    expect(isHandledUrlArg('--start-on-boot')).toBe(false);
    expect(isHandledUrlArg('C:/path/to/file')).toBe(false);
    expect(isHandledUrlArg('ftp://example.com')).toBe(false);
  });
});
