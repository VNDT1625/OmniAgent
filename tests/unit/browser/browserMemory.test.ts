/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/browser/browserMemory — the personal web-agent memory
 * (persona + per-site notes). Uses an in-memory fs double so no real disk or
 * Electron `app` is touched. Verifies: empty defaults, persona round-trip,
 * per-site note append + cap, host extraction, and clearing a site.
 */

import { describe, expect, it } from 'vitest';
import { createBrowserMemory, hostOf, type BrowserMemoryFs } from '@/process/browser/browserMemory';

/** Build an in-memory fs double implementing the BrowserMemoryFs surface. */
const memFs = (): { fs: BrowserMemoryFs; files: Map<string, string> } => {
  const files = new Map<string, string>();
  const fs: BrowserMemoryFs = {
    readFile: async (p) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p) as string;
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    rename: async (oldPath, newPath) => {
      const v = files.get(oldPath);
      if (v === undefined) throw new Error('ENOENT');
      files.set(newPath, v);
      files.delete(oldPath);
    },
    mkdir: async () => undefined,
  };
  return { fs, files };
};

describe('browserMemory — persona + per-site notes', () => {
  it('returns empty defaults when nothing is stored', async () => {
    const { fs } = memFs();
    const mem = createBrowserMemory({ fs, dir: '/tmp/x' });
    expect(await mem.getPersona()).toBe('');
    expect(await mem.getSiteNotes('example.com')).toEqual([]);
    expect(await mem.read()).toEqual({ persona: '', sites: {} });
  });

  it('round-trips the persona', async () => {
    const { fs } = memFs();
    const mem = createBrowserMemory({ fs, dir: '/tmp/x' });
    await mem.setPersona('Always answer in Vietnamese.');
    expect(await mem.getPersona()).toBe('Always answer in Vietnamese.');
  });

  it('appends site notes and caps at 20 (oldest dropped)', async () => {
    const { fs } = memFs();
    const mem = createBrowserMemory({ fs, dir: '/tmp/x' });
    for (let i = 0; i < 25; i++) await mem.addSiteNote('example.com', `note ${i}`);
    const notes = await mem.getSiteNotes('example.com');
    expect(notes).toHaveLength(20);
    expect(notes[0].text).toBe('note 5');
    expect(notes.at(-1)?.text).toBe('note 24');
  });

  it('ignores empty notes and empty hosts', async () => {
    const { fs } = memFs();
    const mem = createBrowserMemory({ fs, dir: '/tmp/x' });
    await mem.addSiteNote('example.com', '   ');
    await mem.addSiteNote('', 'orphan');
    expect(await mem.getSiteNotes('example.com')).toEqual([]);
  });

  it('clears a site', async () => {
    const { fs } = memFs();
    const mem = createBrowserMemory({ fs, dir: '/tmp/x' });
    await mem.addSiteNote('example.com', 'keep then clear');
    await mem.clearSite('example.com');
    expect(await mem.getSiteNotes('example.com')).toEqual([]);
  });

  it('hostOf strips www and lowercases; returns empty for bad input', () => {
    expect(hostOf('https://www.YouTube.com/watch?v=1')).toBe('youtube.com');
    expect(hostOf('http://Example.COM/path')).toBe('example.com');
    expect(hostOf('not a url')).toBe('');
  });
});
