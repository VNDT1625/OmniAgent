import type { AionrsContextBranch } from '@/common';
import {
  areContextBranchesValid,
  estimateContextBranchTokens,
} from '@/renderer/pages/studio/ide/memory/contextBranchUtils';
import { describe, expect, it } from 'vitest';

const branch = (id: string, content: string): AionrsContextBranch => ({
  id,
  title: id,
  summary: `${id} summary`,
  content,
});

describe('context branch editor validation', () => {
  it('accepts bounded branches with unique stable IDs', () => {
    expect(areContextBranchesValid([branch('mcp-web', 'integration rules'), branch('desktop', 'desktop rules')])).toBe(
      true
    );
  });

  it('rejects empty content, duplicate IDs, and content above the runtime limit', () => {
    expect(areContextBranchesValid([branch('empty', ' ')])).toBe(false);
    expect(areContextBranchesValid([branch('same', 'one'), branch('same', 'two')])).toBe(false);
    expect(areContextBranchesValid([branch('large', 'a'.repeat(8_001))])).toBe(false);
  });

  it('shows a deterministic token estimate before activation', () => {
    expect(estimateContextBranchTokens('12345678')).toBe(2);
  });
});
