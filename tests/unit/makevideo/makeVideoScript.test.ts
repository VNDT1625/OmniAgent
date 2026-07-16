/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the script JSON-array extraction/parse helper exported from
 * process/makevideo/makeVideoBridge (`parseScenes`). Tests the parser in
 * isolation — no network or provider calls are made.
 *
 * Covers:
 * - Parses a clean JSON array of scenes.
 * - Strips ```json fences before parsing.
 * - Finds a JSON array embedded in surrounding prose.
 * - Throws a clear error on garbage / non-array input.
 * - Assigns sequential index values and generated ids.
 */

import { describe, expect, it } from 'vitest';
import { parseScenes } from '@/process/makevideo/makeVideoBridge';

/** Deterministic id generator for stable assertions. */
const seqIds = () => {
  let n = 0;
  return () => `sid-${++n}`;
};

const CLEAN = JSON.stringify([
  { title: 'Dawn', narration: 'The city wakes.', imagePrompt: 'aerial shot, soft morning light, anime style' },
  { title: 'Chase', narration: 'They run.', imagePrompt: 'low angle, motion blur, neon, anime style' },
]);

describe('parseScenes', () => {
  it('parses a clean JSON array of scenes', () => {
    const scenes = parseScenes(CLEAN, 2, seqIds());
    expect(scenes).toHaveLength(2);
    expect(scenes[0].title).toBe('Dawn');
    expect(scenes[1].narration).toBe('They run.');
    expect(scenes[0].imagePrompt).toContain('anime style');
    // Image fields default to null until rendered.
    expect(scenes[0].imagePath).toBeNull();
    expect(scenes[0].imageError).toBeNull();
  });

  it('strips ```json fences before parsing', () => {
    const fenced = '```json\n' + CLEAN + '\n```';
    const scenes = parseScenes(fenced, 2, seqIds());
    expect(scenes).toHaveLength(2);
    expect(scenes[0].title).toBe('Dawn');
  });

  it('finds a JSON array embedded in surrounding prose', () => {
    const prose = `Sure! Here is your script:\n\n${CLEAN}\n\nLet me know if you'd like changes.`;
    const scenes = parseScenes(prose, 2, seqIds());
    expect(scenes).toHaveLength(2);
    expect(scenes[1].title).toBe('Chase');
  });

  it('assigns sequential index values and generated ids', () => {
    const scenes = parseScenes(CLEAN, 2, seqIds());
    expect(scenes.map((s) => s.index)).toEqual([0, 1]);
    expect(scenes.map((s) => s.id)).toEqual(['sid-1', 'sid-2']);
  });

  it('handles a nested array inside an imagePrompt without truncating early', () => {
    // The prompt text contains brackets; the balanced-bracket scan must not
    // stop at the first ']'.
    const tricky = JSON.stringify([{ title: 'A', narration: 'B', imagePrompt: 'shot [variant] of a robot' }]);
    const scenes = parseScenes(tricky, 1, seqIds());
    expect(scenes).toHaveLength(1);
    expect(scenes[0].imagePrompt).toBe('shot [variant] of a robot');
  });

  it('throws a clear error on garbage input', () => {
    expect(() => parseScenes('no array here at all', 3, seqIds())).toThrow(/JSON array/i);
    expect(() => parseScenes('', 3, seqIds())).toThrow(/empty/i);
  });

  it('throws when the extracted array is empty', () => {
    expect(() => parseScenes('here: []', 3, seqIds())).toThrow(/non-empty/i);
  });
});
