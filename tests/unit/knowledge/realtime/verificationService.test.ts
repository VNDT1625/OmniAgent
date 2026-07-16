/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createVerificationService } from '@/process/knowledge/realtime/verificationService';
import type { FactSource } from '@/process/knowledge/realtime/rtkTypes';

const src = (url: string): FactSource => ({ url, fetchedAt: '2026-01-01T00:00:00.000Z' });

describe('verificationService', () => {
  const verify = createVerificationService().verify;

  it('rejects an empty proposed value', () => {
    const d = verify({ currentValue: 'a', proposedValue: '  ', sources: [src('https://a.com')] });
    expect(d.action).toBe('reject');
  });

  it('rejects when there are no sources (a model guess is not evidence)', () => {
    const d = verify({ currentValue: '1.0', proposedValue: '2.0', sources: [] });
    expect(d.action).toBe('reject');
    expect(d.reasons.join(' ')).toMatch(/no sources/i);
  });

  it('accepts a change with two independent sources', () => {
    const d = verify({
      currentValue: '1.0',
      proposedValue: '2.0',
      sources: [src('https://a.com/x'), src('https://b.com/y')],
    });
    expect(d.action).toBe('accept');
    expect(d.changed).toBe(true);
    expect(d.confidence).toBeGreaterThan(0);
  });

  it('holds a change for review when only one source backs it', () => {
    const d = verify({ currentValue: '1.0', proposedValue: '2.0', sources: [src('https://a.com')] });
    expect(d.action).toBe('review');
    expect(d.changed).toBe(true);
  });

  it('counts multiple pages on one host as a single independent source', () => {
    const d = verify({
      currentValue: '1.0',
      proposedValue: '2.0',
      sources: [src('https://a.com/1'), src('https://www.a.com/2')],
    });
    expect(d.action).toBe('review'); // still only 1 distinct host
  });

  it('accepts re-confirming an unchanged value with a single source', () => {
    const d = verify({ currentValue: '2.0', proposedValue: '2.0', sources: [src('https://a.com')] });
    expect(d.action).toBe('accept');
    expect(d.changed).toBe(false);
  });

  it('rejects (not reviews) a weak unchanged confirmation with no sources', () => {
    const d = verify({ currentValue: '2.0', proposedValue: '2.0', sources: [] });
    expect(d.action).toBe('reject');
  });

  it('reviews a change when agreement is too low', () => {
    const d = verify({
      currentValue: '1.0',
      proposedValue: '2.0',
      sources: [src('https://a.com'), src('https://b.com'), src('https://c.com')],
      agreement: [true, false, false],
    });
    expect(d.action).toBe('review');
  });
});
