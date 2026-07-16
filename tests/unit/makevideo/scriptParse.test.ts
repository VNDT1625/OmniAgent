/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/makevideo/scriptParse — the robust scene-script
 * extractor. Exercises the lower-level helpers (extractJsonArray, repairJsonText)
 * plus parseScenes' repair-on-failure path that the legacy parser lacked.
 *
 * The original parseScenes contract is also covered by makeVideoScript.test.ts
 * (imported via the bridge re-export); this file targets the new robustness.
 */

import { describe, expect, it } from 'vitest';
import { extractJsonArray, parseScenes, repairJsonText } from '@/process/makevideo/scriptParse';

const seqIds = () => {
  let n = 0;
  return () => `sid-${++n}`;
};

describe('extractJsonArray', () => {
  it('returns null when there is no array', () => {
    expect(extractJsonArray('just prose, no brackets')).toBeNull();
  });

  it('ignores brackets that appear inside strings', () => {
    const text = 'prefix [{"imagePrompt": "a shot ] with a bracket"}] suffix';
    expect(extractJsonArray(text)).toBe('[{"imagePrompt": "a shot ] with a bracket"}]');
  });

  it('handles escaped quotes inside strings without ending the string early', () => {
    const text = '[{"title": "she said \\"hi\\" then [left]"}]';
    expect(extractJsonArray(text)).toBe(text);
  });

  it('extracts the first balanced array embedded in prose', () => {
    const text = 'Here you go:\n[{"a":1},{"b":2}]\nHope that helps!';
    expect(extractJsonArray(text)).toBe('[{"a":1},{"b":2}]');
  });
});

describe('repairJsonText', () => {
  it('drops trailing commas before ] and }', () => {
    expect(repairJsonText('[{"a":1,},]')).toBe('[{"a":1}]');
  });

  it('normalises smart quotes to straight quotes', () => {
    const smart = '[{\u201Ctitle\u201D:\u201CDawn\u201D}]';
    expect(repairJsonText(smart)).toBe('[{"title":"Dawn"}]');
  });

  it('does not touch commas inside string values', () => {
    const input = '[{"narration":"one, two, three"}]';
    expect(repairJsonText(input)).toBe(input);
  });
});

describe('parseScenes — repair fallback', () => {
  it('parses an array that only succeeds after trailing-comma repair', () => {
    const dirty = '```json\n[{"title":"A","narration":"n","imagePrompt":"p",},]\n```';
    const scenes = parseScenes(dirty, 1, seqIds());
    expect(scenes).toHaveLength(1);
    expect(scenes[0].title).toBe('A');
  });

  it('parses an array wrapped in prose with smart quotes', () => {
    const dirty =
      'Sure!\n[{\u201Ctitle\u201D:\u201CDawn\u201D,\u201Cnarration\u201D:\u201Cx\u201D,\u201CimagePrompt\u201D:\u201Cy\u201D}]';
    const scenes = parseScenes(dirty, 1, seqIds());
    expect(scenes[0].title).toBe('Dawn');
    expect(scenes[0].imagePrompt).toBe('y');
  });

  it('strips zero-width characters that would break JSON.parse', () => {
    const dirty = '\uFEFF[{"title":"Z\u200B","narration":"n","imagePrompt":"p"}]';
    const scenes = parseScenes(dirty, 1, seqIds());
    expect(scenes).toHaveLength(1);
  });

  it('assigns sequential indices regardless of an index the model invented', () => {
    const reply =
      '[{"title":"A","narration":"n","imagePrompt":"p","index":99},{"title":"B","narration":"n","imagePrompt":"p","index":7}]';
    const scenes = parseScenes(reply, 2, seqIds());
    expect(scenes.map((s) => s.index)).toEqual([0, 1]);
  });

  it('still throws a clear error on genuinely broken input', () => {
    expect(() => parseScenes('totally not json', 2, seqIds())).toThrow(/JSON array/i);
    expect(() => parseScenes('[{"oops": "no recognised fields"}]', 1, seqIds())).toThrow(/expected shape/i);
  });
});
