/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/browser/research/readability — main-content extraction.
 * The page driver is a fake `executeJavaScript`, so these tests assert the Node
 * side: the script string is run, and the untrusted result is coerced safely
 * (every field validated, never throws).
 */

import { describe, expect, it, vi } from 'vitest';
import { extractReadable, READABILITY_SCRIPT, type ReadabilityDriver } from '@/process/browser/research/readability';

const driverReturning = (value: unknown): ReadabilityDriver => ({
  executeJavaScript: vi.fn(async () => value),
});

describe('extractReadable', () => {
  it('runs the readability script and returns the coerced content', async () => {
    const driver = driverReturning({ title: 'Hello', text: 'body text', byline: 'Jane', excerpt: 'ex', length: 9 });
    const result = await extractReadable(driver);
    expect(driver.executeJavaScript).toHaveBeenCalledWith(READABILITY_SCRIPT);
    expect(result).toEqual({ title: 'Hello', text: 'body text', byline: 'Jane', excerpt: 'ex', length: 9 });
  });

  it('coerces missing/invalid fields to safe defaults', async () => {
    const driver = driverReturning({ title: 123, text: null, length: 'nope' });
    const result = await extractReadable(driver);
    expect(result).toEqual({ title: '', text: '', byline: '', excerpt: '', length: 0 });
  });

  it('returns the empty content when the result is not an object', async () => {
    const driver = driverReturning('not an object');
    const result = await extractReadable(driver);
    expect(result).toEqual({ title: '', text: '', byline: '', excerpt: '', length: 0 });
  });

  it('never rejects when executeJavaScript throws', async () => {
    const driver: ReadabilityDriver = {
      executeJavaScript: vi.fn(async () => {
        throw new Error('page gone');
      }),
    };
    const result = await extractReadable(driver);
    expect(result.text).toBe('');
    expect(result.length).toBe(0);
  });

  it('the in-page script contains no template-literal hazards', () => {
    // The script is embedded inside a template literal in the source, so it must
    // not itself contain backticks or ${...} interpolation.
    expect(READABILITY_SCRIPT.includes('`')).toBe(false);
    expect(READABILITY_SCRIPT.includes('${')).toBe(false);
  });
});
