/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { commandSimilarities, cosineSparse, embedText } from '@/process/terminal/commandDoc/commandVector';
import { rankCommands } from '@/process/terminal/commandDoc/commandScore';
import type { CommandRecord } from '@/process/terminal/commandDoc/commandTypes';

const NOW = Date.parse('2026-01-08T00:00:00.000Z');

const rec = (over: Partial<CommandRecord> = {}): CommandRecord => ({
  command: 'bun start',
  program: 'bun',
  count: 5,
  successCount: 5,
  firstUsedAt: NOW - 1000,
  lastUsedAt: NOW - 1000,
  lastExitCode: 0,
  ...over,
});

describe('commandVector.embedText', () => {
  it('is empty for blank text and non-empty for words', () => {
    expect(embedText('').size).toBe(0);
    expect(embedText('bun install').size).toBeGreaterThan(0);
  });
});

describe('commandVector.cosineSparse', () => {
  it('is 1 for identical text and 0 when one side is empty', () => {
    expect(cosineSparse(embedText('bun install'), embedText('bun install'))).toBeCloseTo(1, 5);
    expect(cosineSparse(embedText('bun install'), embedText(''))).toBe(0);
  });
  it('scores shared-token text higher than unrelated text', () => {
    const query = embedText('bun install');
    const related = cosineSparse(query, embedText('bun install deps'));
    const unrelated = cosineSparse(query, embedText('git push origin'));
    expect(related).toBeGreaterThan(unrelated);
  });
});

describe('commandVector.commandSimilarities', () => {
  it('returns an empty map for blank input', () => {
    expect(commandSimilarities([rec()], '   ').size).toBe(0);
  });
  it('keys similarities by the exact command string', () => {
    const sims = commandSimilarities([rec({ command: 'bun install' })], 'bun install');
    expect(sims.get('bun install')).toBeGreaterThan(0.9);
  });
});

describe('rankCommands with vectorSim (additive, non-breaking)', () => {
  it('recalls a semantically-close command that has no lexical prefix match', () => {
    const records = [rec({ command: 'bun install', count: 3 }), rec({ command: 'git push', count: 3 })];
    const vectorSim = new Map<string, number>([
      ['bun install', 0.8],
      ['git push', 0.0],
    ]);
    // 'deps' has no lexical match for either, but vector recall surfaces 'bun install'.
    const ranked = rankCommands(records, { prefix: 'deps', now: NOW, vectorSim }, 5);
    expect(ranked.map((r) => r.command)).toContain('bun install');
    expect(ranked.map((r) => r.command)).not.toContain('git push');
  });
  it('still drops everything when no prefix match and no vector provided', () => {
    const records = [rec({ command: 'bun install' })];
    expect(rankCommands(records, { prefix: 'zzz', now: NOW }, 5)).toEqual([]);
  });
});
