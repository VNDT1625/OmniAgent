/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the shared workspace-primer builder. Pure string assertions:
 * verify ordering, optional Planning Mode block, empty-rules path, and that
 * the session-memory block is appended idempotently.
 */

import { describe, expect, it } from 'vitest';
import { buildIdeMemorySection, buildWorkspacePrimer, withIdeMemorySection } from '@/process/ide/workspacePrimer';

const baseInput = {
  rootPath: '/repo/AionUi',
  rules: ['First rule', 'Second rule'] as const,
  planningEnabled: false,
  sessionMemoryId: 'sess-42',
};

describe('buildWorkspacePrimer', () => {
  it('emits the workspace guide + project rules + session memory blocks', () => {
    const primer = buildWorkspacePrimer(baseInput);
    expect(primer).toContain('## IDE workspace guide');
    expect(primer).toContain('Workspace root: /repo/AionUi');
    expect(primer).toContain('## Project rules');
    expect(primer).toContain('- First rule');
    expect(primer).toContain('## Session memory (your ephemeral scratchpad)');
    expect(primer).toContain('Your session memory id is: sess-42');
  });

  it('includes Planning Mode when enabled', () => {
    const primer = buildWorkspacePrimer({ ...baseInput, planningEnabled: true });
    expect(primer).toContain('## Planning Mode: ON');
  });

  it('omits Planning Mode when disabled', () => {
    const primer = buildWorkspacePrimer(baseInput);
    expect(primer).not.toContain('Planning Mode: ON');
  });

  it('omits the Project rules block when rules is empty', () => {
    const primer = buildWorkspacePrimer({ ...baseInput, rules: [] });
    expect(primer).not.toContain('## Project rules');
    // session memory + workspace guide still present
    expect(primer).toContain('## IDE workspace guide');
    expect(primer).toContain('## Session memory');
  });
});

describe('buildIdeMemorySection / withIdeMemorySection', () => {
  it('embeds the sessionId verbatim', () => {
    expect(buildIdeMemorySection('sess-X')).toContain('Your session memory id is: sess-X');
  });

  it('is idempotent: a second append does not duplicate the block', () => {
    const once = withIdeMemorySection('sess-1', 'existing');
    const twice = withIdeMemorySection('sess-1', once);
    const matches = twice.match(/## Session memory \(your ephemeral scratchpad\)/g);
    expect(matches?.length).toBe(1);
  });

  it('preserves existing rules when prepending', () => {
    const combined = withIdeMemorySection('sess-1', '## Project rules\n- existing');
    expect(combined.startsWith('## Project rules')).toBe(true);
    expect(combined).toContain('- existing');
    expect(combined).toContain('## Session memory');
  });
});
