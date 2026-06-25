/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the Obsidian-style wiki link grammar (path + alias resolution).
 */

import { describe, expect, it } from 'vitest';
import {
  extractWikiTargets,
  findBacklinks,
  parseWikiToken,
  resolveWikiTarget,
  wikiTargetExists,
} from '@/renderer/pages/manager/notes/linking/wikiLinks';
import type { Note } from '@/process/manager/managerTypes';

const learn = (id: string, title: string, body = ''): Note => ({
  id,
  category: 'learn',
  title,
  body,
  tags: [],
  linkedTaskId: null,
  linkedEventId: null,
  createdAt: 1,
  updatedAt: 1,
});

describe('parseWikiToken', () => {
  it('parses a plain target', () => {
    expect(parseWikiToken('Class Diagram')).toEqual({ target: 'Class Diagram' });
  });
  it('parses target + alias', () => {
    expect(parseWikiToken('c4/Class Diagram|the class view')).toEqual({
      target: 'c4/Class Diagram',
      alias: 'the class view',
    });
  });
});

describe('resolveWikiTarget', () => {
  const notes = [learn('cd', 'Class Diagram'), learn('c4', 'C4')];

  it('resolves an exact title', () => {
    expect(resolveWikiTarget('Class Diagram', notes)?.id).toBe('cd');
  });
  it('resolves a path-style target by its last segment', () => {
    expect(resolveWikiTarget('c4/Class Diagram', notes)?.id).toBe('cd');
    expect(resolveWikiTarget('models/c4/Class Diagram', notes)?.id).toBe('cd');
  });
  it('is case-insensitive', () => {
    expect(resolveWikiTarget('c4/class diagram', notes)?.id).toBe('cd');
  });
  it('returns undefined for an unknown target', () => {
    expect(resolveWikiTarget('c4/Sequence Diagram', notes)).toBeUndefined();
    expect(wikiTargetExists('Ghost', notes)).toBe(false);
  });
  it('prefers an exact full-title match over a last-segment match', () => {
    const withFull = [learn('full', 'c4/Class Diagram'), learn('seg', 'Class Diagram')];
    expect(resolveWikiTarget('c4/Class Diagram', withFull)?.id).toBe('full');
  });
});

describe('extractWikiTargets', () => {
  it('strips aliases and de-duplicates by target', () => {
    const body = 'see [[c4/Class Diagram|the view]] and again [[c4/Class Diagram]]';
    expect(extractWikiTargets(body)).toEqual(['c4/Class Diagram']);
  });
});

describe('findBacklinks', () => {
  it('counts a path-style link as a backlink to the resolved note', () => {
    const cd = learn('cd', 'Class Diagram');
    const c4 = learn('c4', 'C4', 'this model contains [[c4/Class Diagram|the class view]]');
    const notes = [cd, c4];
    const backlinks = findBacklinks(cd, notes);
    expect(backlinks.map((n) => n.id)).toEqual(['c4']);
  });
});
