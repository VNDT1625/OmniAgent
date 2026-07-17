import { describe, expect, it } from 'vitest';
import { getSecretMarkers, renderSecretMarkers } from '@/renderer/utils/chat/secretMarkers';

describe('secretMarkers', () => {
  it('extracts supported aliases once in their first-occurrence order', () => {
    expect(getSecretMarkers('A {{secret:TEST}} B {{secret:API_KEY}} C {{secret:TEST}}')).toEqual([
      { alias: 'TEST', marker: '{{secret:TEST}}' },
      { alias: 'API_KEY', marker: '{{secret:API_KEY}}' },
    ]);
  });

  it('recognizes the marker pattern emitted in an assistant answer for local reveal', () => {
    expect(getSecretMarkers('TEST là {{secret:TEST}}.')).toEqual([
      { alias: 'TEST', marker: '{{secret:TEST}}' },
    ]);
  });

  it('keeps unresolved markers opaque and inserts only explicitly revealed values', () => {
    expect(
      renderSecretMarkers(
        'A {{secret:TEST}} B {{secret:MISSING}}',
        { TEST: 'local-value' },
        new Set(),
        (alias) => alias
      )
    ).toBe('A local-value B {{secret:MISSING}}');
  });

  it('uses a safe fallback after a local reveal cannot resolve an alias', () => {
    expect(
      renderSecretMarkers('{{secret:MISSING}}', {}, new Set(['MISSING']), (alias) => `[${alias} unavailable]`)
    ).toBe('[MISSING unavailable]');
  });
});
