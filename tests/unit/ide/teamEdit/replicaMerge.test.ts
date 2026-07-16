/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { mergeText3 } from '@process/ide/teamEdit/cloud/cloudReplicaMerge';

describe('cloud replica three-way merge', () => {
  it('keeps one-sided local edits', () => {
    expect(mergeText3('a\nb', 'a\nlocal', 'a\nb')).toEqual({ ok: true, content: 'a\nlocal', autoMerged: false });
  });

  it('merges edits on different lines', () => {
    expect(mergeText3('one\ntwo\nthree', 'ONE\ntwo\nthree', 'one\ntwo\nTHREE')).toEqual({
      ok: true,
      content: 'ONE\ntwo\nTHREE',
      autoMerged: true,
    });
  });

  it('deduplicates the same edit made offline on both replicas', () => {
    expect(mergeText3('before', 'after', 'after')).toEqual({ ok: true, content: 'after', autoMerged: false });
  });

  it('returns both versions when edits overlap', () => {
    const result = mergeText3('value = 1', 'value = 2', 'value = 3');
    expect(result.ok).toBe(false);
    expect(result.content).toContain('<<<<<<< LOCAL\nvalue = 2');
    expect(result.content).toContain('value = 3\n>>>>>>> REMOTE');
  });
});
