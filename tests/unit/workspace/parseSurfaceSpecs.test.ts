/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the renderer-side instruction parser that fans a single chat
 * instruction out into parallel surface specs (one per detected target).
 */

import { describe, expect, it } from 'vitest';
import { parseSurfaceSpecs } from '@/renderer/pages/workspace/constants';

describe('parseSurfaceSpecs', () => {
  it('splits a website + a file into a browser surface and an editor surface', () => {
    const specs = parseSurfaceSpecs('search jobs on glassdoor.com and edit notes.md', 'gpt');
    expect(specs).toHaveLength(2);
    const browser = specs.find((s) => s.kind === 'browser');
    const editor = specs.find((s) => s.kind === 'editor');
    expect(browser).toMatchObject({ kind: 'browser', model: 'gpt' });
    expect(browser && 'url' in browser && browser.url).toContain('glassdoor.com');
    expect(editor).toMatchObject({ kind: 'editor', model: 'gpt' });
    expect(editor && 'filePath' in editor && editor.filePath).toBe('notes.md');
  });

  it('passes the full instruction to every surface as context', () => {
    const instruction = 'open example.com then update report.txt with a summary';
    const specs = parseSurfaceSpecs(instruction, 'm');
    expect(specs.every((s) => s.instruction === instruction)).toBe(true);
  });

  it('falls back to a single browser surface when no target is detected', () => {
    const specs = parseSurfaceSpecs('what is the weather like today', 'm');
    expect(specs).toHaveLength(1);
    expect(specs[0].kind).toBe('browser');
  });

  it('returns nothing for blank input', () => {
    expect(parseSurfaceSpecs('   ', 'm')).toHaveLength(0);
  });

  it('detects multiple websites as separate browser surfaces', () => {
    const specs = parseSurfaceSpecs('compare prices on amazon.com and ebay.com', 'm');
    const browsers = specs.filter((s) => s.kind === 'browser');
    expect(browsers.length).toBeGreaterThanOrEqual(2);
  });
});
