import { describe, expect, it } from 'vitest';
import { buildBrowserControlSessionUpdate, mergeBrowserControlSessionServer } from '@/renderer/hooks/mcp/catalog';

describe('mergeBrowserControlSessionServer', () => {
  it('preserves custom MCP servers while replacing a stale browser snapshot', () => {
    const custom = { id: 'custom', name: 'my-tools', transport: { type: 'sse' as const, url: 'http://custom' } };
    const stale = {
      id: 'browser',
      name: 'aionui-browser-control',
      transport: { type: 'sse' as const, url: 'http://old' },
    };
    const fresh = { ...stale, transport: { type: 'sse' as const, url: 'http://new' } };
    expect(mergeBrowserControlSessionServer([custom, stale], fresh)).toEqual([custom, fresh]);
  });

  it('does not duplicate browser entries when the snapshot is already current', () => {
    const browser = {
      id: 'browser',
      name: 'aionui-browser-control',
      transport: { type: 'sse' as const, url: 'http://live' },
    };
    expect(mergeBrowserControlSessionServer([browser], browser)).toEqual([browser]);
  });

  it('keeps a missing browser server opt-in unless explicitly requested', () => {
    const custom = { id: 'custom', name: 'my-tools', transport: { type: 'sse' as const, url: 'http://custom' } };
    const browser = {
      id: 'browser',
      name: 'aionui-browser-control',
      transport: { type: 'sse' as const, url: 'http://live' },
    };
    expect(buildBrowserControlSessionUpdate([custom], browser)).toBeNull();
    expect(buildBrowserControlSessionUpdate([custom], browser, true)).toEqual([custom, browser]);
  });

  it('refreshes only a stale browser snapshot while preserving custom MCPs', () => {
    const custom = { id: 'custom', name: 'my-tools', transport: { type: 'sse' as const, url: 'http://custom' } };
    const stale = {
      id: 'browser',
      name: 'aionui-browser-control',
      transport: { type: 'sse' as const, url: 'http://old' },
    };
    const fresh = { ...stale, transport: { type: 'sse' as const, url: 'http://new' } };
    expect(buildBrowserControlSessionUpdate([custom, stale], fresh)).toEqual([custom, fresh]);
  });
});
