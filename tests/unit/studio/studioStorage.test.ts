/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the Studio recent/starred local store. Exercises de-dup,
 * ordering (newest first), the recent cap, star toggling, and corruption
 * tolerance. A minimal in-memory `localStorage` stub keeps this in the node
 * project (no DOM needed).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal localStorage stub installed before importing the module under test.
const store = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string): string | null => (store.has(key) ? (store.get(key) as string) : null),
  setItem: (key: string, value: string): void => void store.set(key, value),
  removeItem: (key: string): void => void store.delete(key),
  clear: (): void => store.clear(),
};
vi.stubGlobal('localStorage', localStorageStub);

import {
  addRecentFile,
  baseName,
  clearRecentFiles,
  getRecentFiles,
  getStarredFiles,
  isStarred,
  removeRecentFile,
  toggleStarred,
} from '@/renderer/pages/studio/studioStorage';

beforeEach(() => {
  store.clear();
});

describe('studioStorage.baseName', () => {
  it('extracts the basename from posix and windows paths', () => {
    expect(baseName('/a/b/report.pdf')).toBe('report.pdf');
    expect(baseName('C:\\docs\\notes.txt')).toBe('notes.txt');
    expect(baseName('bare.md')).toBe('bare.md');
  });
});

describe('studioStorage recent list', () => {
  it('adds newest first and de-duplicates by path', () => {
    addRecentFile('/a/one.txt');
    addRecentFile('/a/two.txt');
    addRecentFile('/a/one.txt'); // re-open moves it to front
    const recent = getRecentFiles();
    expect(recent.map((e) => e.path)).toEqual(['/a/one.txt', '/a/two.txt']);
  });

  it('caps the list at 50 entries', () => {
    for (let i = 0; i < 60; i++) addRecentFile(`/f/${i}.txt`);
    expect(getRecentFiles()).toHaveLength(50);
    // Most recent is the last added.
    expect(getRecentFiles()[0].path).toBe('/f/59.txt');
  });

  it('removes and clears entries', () => {
    addRecentFile('/a/one.txt');
    addRecentFile('/a/two.txt');
    removeRecentFile('/a/one.txt');
    expect(getRecentFiles().map((e) => e.path)).toEqual(['/a/two.txt']);
    clearRecentFiles();
    expect(getRecentFiles()).toEqual([]);
  });

  it('tolerates corrupt storage', () => {
    store.set('studio.recentFiles', '{not json');
    expect(getRecentFiles()).toEqual([]);
  });
});

describe('studioStorage starred list', () => {
  it('toggles starred state on and off', () => {
    expect(isStarred('/a/one.txt')).toBe(false);
    toggleStarred('/a/one.txt');
    expect(isStarred('/a/one.txt')).toBe(true);
    expect(getStarredFiles().map((e) => e.path)).toEqual(['/a/one.txt']);
    toggleStarred('/a/one.txt');
    expect(isStarred('/a/one.txt')).toBe(false);
    expect(getStarredFiles()).toEqual([]);
  });
});
