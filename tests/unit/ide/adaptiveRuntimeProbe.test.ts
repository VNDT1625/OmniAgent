import { describe, expect, it } from 'vitest';
import { selectAdaptiveEvidence } from '@/process/ide/adaptiveRuntimeProbe';

describe('selectAdaptiveEvidence', () => {
  it('uses full CDP evidence when a web target is available', () => {
    expect(selectAdaptiveEvidence('web', true, false)).toMatchObject({
      adapter: 'web-cdp',
      level: 'full',
      capabilities: ['interaction', 'network', 'stack', 'coverage'],
    });
  });

  it('reports runtime evidence for native log streams', () => {
    expect(selectAdaptiveEvidence('android', false, true)).toMatchObject({
      adapter: 'native-log',
      level: 'runtime',
      capabilities: ['stack'],
    });
  });

  it('prefers native accessibility when the platform exposes a structured UI tree', () => {
    expect(selectAdaptiveEvidence('windows', false, true, true)).toMatchObject({
      adapter: 'native-accessibility',
      level: 'accessibility',
      capabilities: ['interaction', 'stack'],
    });
  });

  it('falls back to visual evidence when no structured hook exists', () => {
    expect(selectAdaptiveEvidence('windows', false, false)).toMatchObject({
      adapter: 'visual-fallback',
      level: 'visual',
      capabilities: ['screen'],
    });
  });
});
