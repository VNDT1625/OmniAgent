/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { matchesAnyPattern, matchesGlob, normaliseRelPath } from '@/process/ide/hooks/ideHookMatch';

describe('normaliseRelPath', () => {
  it('forward-slashes, lowercases, strips leading ./ and /', () => {
    expect(normaliseRelPath('.\\Src\\App.TS')).toBe('src/app.ts');
    expect(normaliseRelPath('/a/B.ts')).toBe('a/b.ts');
  });
});

describe('matchesGlob', () => {
  it('matches * within a single segment', () => {
    expect(matchesGlob('src/app.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlob('src/sub/app.ts', 'src/*.ts')).toBe(false);
  });

  it('matches ** across directories', () => {
    expect(matchesGlob('src/a/b/c.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('src/a/b/c.ts', 'src/**')).toBe(true);
  });

  it('matches ? as exactly one non-slash char', () => {
    expect(matchesGlob('a/b.ts', 'a/?.ts')).toBe(true);
    expect(matchesGlob('a/bb.ts', 'a/?.ts')).toBe(false);
  });

  it('a slashless pattern matches the basename anywhere', () => {
    expect(matchesGlob('src/deep/file.tsx', '*.tsx')).toBe(true);
    expect(matchesGlob('file.tsx', '*.tsx')).toBe(true);
    expect(matchesGlob('file.ts', '*.tsx')).toBe(false);
  });

  it('is case-insensitive and slash-normalised', () => {
    expect(matchesGlob('SRC\\App.TSX', 'src/*.tsx')).toBe(true);
  });
});

describe('matchesAnyPattern', () => {
  it('empty pattern list matches anything', () => {
    expect(matchesAnyPattern('whatever/x.ts', [])).toBe(true);
  });

  it('matches when ANY pattern matches', () => {
    expect(matchesAnyPattern('src/a.ts', ['*.md', 'src/*.ts'])).toBe(true);
    expect(matchesAnyPattern('src/a.js', ['*.md', 'src/*.ts'])).toBe(false);
  });

  it('ignores blank patterns', () => {
    expect(matchesAnyPattern('src/a.ts', ['  ', 'src/*.ts'])).toBe(true);
  });
});
