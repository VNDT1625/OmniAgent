/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { lookupRemap, SEED_REMAPS } from '@/process/terminal/smartFix/commandRemap';

describe('commandRemap.lookupRemap', () => {
  it('returns the built-in seed remap for a known program', async () => {
    const remap = await lookupRemap('gemini');
    expect(remap).not.toBeNull();
    expect(remap?.to).toBe(SEED_REMAPS.gemini.to);
    expect(remap?.source).toBe('seed');
    expect(remap?.from).toBe('gemini');
  });

  it('is case-insensitive on the program key', async () => {
    expect((await lookupRemap('GEMINI'))?.to).toBe(SEED_REMAPS.gemini.to);
  });

  it('returns null for an unknown program', async () => {
    expect(await lookupRemap('bun')).toBeNull();
  });

  it('returns null for empty input', async () => {
    expect(await lookupRemap('   ')).toBeNull();
  });

  it('prefers the resolver (RTK) over the seed', async () => {
    const resolver = vi.fn().mockResolvedValue({ to: 'newtool', updateUrl: 'https://x' });
    const remap = await lookupRemap('gemini', resolver);
    expect(remap?.to).toBe('newtool');
    expect(remap?.source).toBe('realtime');
    expect(resolver).toHaveBeenCalledWith('gemini');
  });

  it('falls back to the seed when the resolver returns null', async () => {
    const resolver = vi.fn().mockResolvedValue(null);
    expect((await lookupRemap('gemini', resolver))?.source).toBe('seed');
  });

  it('falls back to the seed when the resolver throws', async () => {
    const resolver = vi.fn().mockRejectedValue(new Error('offline'));
    expect((await lookupRemap('gemini', resolver))?.source).toBe('seed');
  });

  it('ignores a resolver result that maps to the same program', async () => {
    const resolver = vi.fn().mockResolvedValue({ to: 'gemini' });
    // resolver result equals the key → ignored; seed still applies.
    expect((await lookupRemap('gemini', resolver))?.source).toBe('seed');
  });

  it('returns null when neither resolver nor seed knows the program', async () => {
    const resolver = vi.fn().mockResolvedValue(null);
    expect(await lookupRemap('unknowncli', resolver)).toBeNull();
  });
});
