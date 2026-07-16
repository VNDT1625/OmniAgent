/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the pure apply helpers (`common/router9/applyPlan.ts`) — home
 * expansion + JSON deep-merge + the merge-strategy resolver. No filesystem.
 */

import { describe, expect, it } from 'vitest';
import { deepMerge, expandHome, mergeConfigContent } from '@/common/router9';

describe('expandHome', () => {
  it('expands a leading ~ to the home dir', () => {
    expect(expandHome('~/.claude/config.json', '/home/me')).toBe('/home/me/.claude/config.json');
    expect(expandHome('~', '/home/me')).toBe('/home/me');
    expect(expandHome('~\\.openclaw\\openclaw.json', '/home/me')).toBe('/home/me/.openclaw\\openclaw.json');
  });

  it('leaves absolute paths and mid-string tildes untouched', () => {
    expect(expandHome('/etc/config', '/home/me')).toBe('/etc/config');
    expect(expandHome('/opt/a~b', '/home/me')).toBe('/opt/a~b');
  });
});

describe('deepMerge', () => {
  it('merges nested objects with incoming winning on conflicts', () => {
    const existing = { a: 1, nested: { keep: true, override: 'old' } };
    const incoming = { nested: { override: 'new', added: 2 }, b: 3 };
    expect(deepMerge(existing, incoming)).toEqual({
      a: 1,
      b: 3,
      nested: { keep: true, override: 'new', added: 2 },
    });
  });

  it('replaces arrays wholesale (no concat)', () => {
    expect(deepMerge({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] });
  });

  it('does not mutate the inputs', () => {
    const existing = { nested: { a: 1 } };
    const incoming = { nested: { b: 2 } };
    deepMerge(existing, incoming);
    expect(existing).toEqual({ nested: { a: 1 } });
    expect(incoming).toEqual({ nested: { b: 2 } });
  });
});

describe('mergeConfigContent', () => {
  const incoming = JSON.stringify({ anthropic_api_base: 'http://x/v1', anthropic_api_key: 'k' }, null, 2);

  it('deep-merges JSON into an existing file, preserving unrelated keys', () => {
    const existingRaw = JSON.stringify({ theme: 'dark', anthropic_api_key: 'old' }, null, 2);
    const out = mergeConfigContent({
      format: 'json',
      mergeStrategy: 'deepMerge',
      incomingContent: incoming,
      existingRaw,
    });
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out as string);
    expect(parsed).toEqual({ theme: 'dark', anthropic_api_base: 'http://x/v1', anthropic_api_key: 'k' });
  });

  it('writes incoming verbatim when the file is absent', () => {
    const out = mergeConfigContent({
      format: 'json',
      mergeStrategy: 'deepMerge',
      incomingContent: incoming,
      existingRaw: undefined,
    });
    expect(out).toBe(incoming);
  });

  it('treats an empty existing file as an empty object', () => {
    const out = mergeConfigContent({
      format: 'json',
      mergeStrategy: 'deepMerge',
      incomingContent: incoming,
      existingRaw: '   ',
    });
    expect(JSON.parse(out as string)).toEqual(JSON.parse(incoming));
  });

  it('returns null for createIfMissing when the file already exists', () => {
    const out = mergeConfigContent({
      format: 'json',
      mergeStrategy: 'createIfMissing',
      incomingContent: incoming,
      existingRaw: '{}',
    });
    expect(out).toBeNull();
  });

  it('replaces wholesale for the replace strategy', () => {
    const out = mergeConfigContent({
      format: 'json',
      mergeStrategy: 'replace',
      incomingContent: incoming,
      existingRaw: '{"a":1}',
    });
    expect(out).toBe(incoming);
  });

  it('throws when the existing JSON is corrupt (never silently loses it)', () => {
    expect(() =>
      mergeConfigContent({
        format: 'json',
        mergeStrategy: 'deepMerge',
        incomingContent: incoming,
        existingRaw: '{not json',
      })
    ).toThrow(/not valid JSON/);
  });
});
