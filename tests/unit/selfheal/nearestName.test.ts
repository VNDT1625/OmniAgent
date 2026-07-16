/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { levenshtein, nearestName } from '@process/selfheal/nearestName';

describe('levenshtein', () => {
  it('computes basic edit distances', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('a', '')).toBe(1);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('GitBranch', 'Branch')).toBe(3);
  });
});

describe('nearestName', () => {
  const icons = ['Branch', 'BranchTwo', 'Bug', 'Cat', 'Terminal'];

  it('maps GitBranch → Branch', () => {
    expect(nearestName('GitBranch', icons)?.name).toBe('Branch');
  });

  it('returns exact match with distance 0', () => {
    expect(nearestName('Bug', icons)).toEqual({ name: 'Bug', distance: 0 });
  });

  it('returns undefined when nothing is close enough (guards short names)', () => {
    // "Xyz" (len 3) → limit = min(4, floor(3*0.5)) = 1; nothing within 1 edit.
    expect(nearestName('Xyz', icons)).toBeUndefined();
  });

  it('breaks ties by shorter then lexicographic candidate', () => {
    // Both Branch (d=?) considered; ensure deterministic preference for shorter.
    const match = nearestName('Branchh', ['Branch', 'BranchTwo']);
    expect(match?.name).toBe('Branch');
  });
});
