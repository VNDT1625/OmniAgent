/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for elementInspectorLocator — the pure mapping core behind Quick
 * Test's visual element picker. Maps a PickedElement (DOM snapshot + optional
 * React fiber source) to the code that renders it, and renders an agent brief.
 */

import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pruneInspectEvidence, resolveFullPageSize } from '@/process/ide/elementInspectorBridge';
import {
  locateElement,
  renderElementBrief,
  renderMultiElementBrief,
  type PickedElement,
} from '@/process/ide/elementInspectorLocator';
import type { KnowledgeGraph } from '@/process/ide/understandTypes';
import { captureAtIntrinsicZoom, capturePageViewportPng } from '@/process/testing/engines/ffmpegVideoBackend';

const node = (id: string, layer: 'ui' | 'api' | 'service' | 'util' = 'ui', summary = '') => ({
  id,
  label: id.split('/').pop() ?? id,
  group: 'src',
  layer,
  summary,
  summarySource: 'llm' as const,
  tags: [],
  symbols: [
    {
      name:
        id
          .split('/')
          .pop()
          ?.replace(/\.[^.]+$/, '') ?? 'fn',
      kind: 'function' as const,
      line: 12,
    },
  ],
  language: 'typescript',
  importedBy: 1,
  fingerprint: 'fp-' + id,
});

const graph: KnowledgeGraph = {
  rootPath: '/repo',
  version: 2,
  builtAt: 1000,
  nodes: [
    node('src/pages/Hero.tsx', 'ui', 'Landing hero section'),
    node('src/hooks/useCheckout.ts', 'service', 'Checkout flow'),
    node('src/api/billing.ts', 'api', 'Billing API'),
  ],
  edges: [
    { from: 'src/pages/Hero.tsx', to: 'src/hooks/useCheckout.ts' },
    { from: 'src/hooks/useCheckout.ts', to: 'src/api/billing.ts' },
  ],
  tours: [],
  truncated: false,
  fileCount: 3,
};

const makeElement = (overrides: Partial<PickedElement> = {}): PickedElement => ({
  selector: 'button#hero-cta.btn',
  tagName: 'button',
  id: 'hero-cta',
  classes: ['btn', 'btn-lg'],
  text: 'Start free trial',
  attributes: { role: 'button' },
  rect: { x: 100, y: 200, width: 160, height: 48 },
  styles: { color: 'rgb(255, 255, 255)', backgroundColor: 'rgb(47, 107, 255)', fontSize: '16px' },
  ...overrides,
});

describe('locateElement', () => {
  it('prefers the React fiber source for an exact file:line (dev mode)', () => {
    const el = makeElement({
      source: { fileName: 'C:/repo/src/pages/Hero.tsx', lineNumber: 42 },
      componentName: 'HeroCta',
    });
    const located = locateElement(el, graph);
    expect(located.resolvedBy).toBe('fiber-source');
    expect(located.file).toBe('src/pages/Hero.tsx');
    expect(located.line).toBe(42);
    expect(located.symbol).toBe('HeroCta');
    // Outgoing graph edges become the "uses" list.
    expect(located.uses).toContain('src/hooks/useCheckout.ts');
    expect(located.summary).toBe('Landing hero section');
  });

  it('surfaces the authored path even when the source file is not in the graph', () => {
    const el = makeElement({
      source: { fileName: '/repo/node_modules/lib/Widget.js', lineNumber: 7 },
      componentName: 'Widget',
    });
    const located = locateElement(el, graph);
    expect(located.resolvedBy).toBe('fiber-source');
    expect(located.file).toBe('repo/node_modules/lib/Widget.js');
    expect(located.line).toBe(7);
    expect(located.uses).toEqual([]);
  });

  it('falls back to token matching when there is no fiber source', () => {
    // Selector/text tokens (hero) overlap the Hero.tsx node label + symbol.
    const el = makeElement({ selector: 'button.hero', text: 'Hero start', classes: ['hero'] });
    const located = locateElement(el, graph);
    expect(located.resolvedBy).toBe('token-match');
    expect(located.file).toBe('src/pages/Hero.tsx');
    expect(located.line).toBe(12);
  });

  it('returns a resolvedBy=none result (still useful) when nothing matches', () => {
    const el = makeElement({ selector: 'div.xyzzy', text: '', id: undefined, classes: [] });
    const located = locateElement(el, graph);
    expect(located.resolvedBy).toBe('none');
    expect(located.file).toBeNull();
    expect(located.line).toBeNull();
  });

  it('handles a null graph gracefully when no source metadata exists', () => {
    const located = locateElement(makeElement(), null);
    expect(located.resolvedBy).toBe('none');
    expect(located.file).toBeNull();
  });

  it('keeps an exact workspace-relative fiber source when the graph is unavailable', () => {
    const located = locateElement(
      makeElement({ source: { fileName: 'C:/repo/src/pages/Hero.tsx', lineNumber: 42 } }),
      null,
      'C:/repo'
    );
    expect(located.resolvedBy).toBe('fiber-source');
    expect(located.file).toBe('src/pages/Hero.tsx');
    expect(located.line).toBe(42);
  });

  it('accepts one exact component symbol as a strong graph match', () => {
    const located = locateElement(
      makeElement({ componentName: 'Hero', selector: 'main > div', text: '', id: undefined, classes: [] }),
      graph
    );
    expect(located.resolvedBy).toBe('token-match');
    expect(located.file).toBe('src/pages/Hero.tsx');
  });
});

describe('renderElementBrief', () => {
  it('leads with the user request and gives the concrete code anchor', () => {
    const located = locateElement(
      makeElement({ source: { fileName: 'src/pages/Hero.tsx', lineNumber: 42 }, componentName: 'HeroCta' }),
      graph
    );
    const brief = renderElementBrief(located, 'nudge this up 20px');
    expect(brief).toContain('> nudge this up 20px');
    expect(brief).toContain('`src/pages/Hero.tsx:42`');
    expect(brief).toContain('HeroCta');
    expect(brief).toContain('src/hooks/useCheckout.ts');
    // Carries the box + key styles so a design change is unambiguous.
    expect(brief).toContain('w 160');
    expect(brief).toContain('16px');
    // Steers the agent to the project UI stack.
    expect(brief).toContain('Arco + UnoCSS');
  });

  it('still renders a precise description when the request is empty', () => {
    const located = locateElement(makeElement({ source: { fileName: 'src/pages/Hero.tsx', lineNumber: 42 } }), graph);
    const brief = renderElementBrief(located, '');
    expect(brief).toContain('Picked element');
    expect(brief).toContain('`src/pages/Hero.tsx:42`');
    expect(brief).not.toContain('> ');
  });

  it('explains the limitation when the element is not tied to a source file', () => {
    const located = locateElement(makeElement({ selector: 'div.xyzzy', text: '', id: undefined, classes: [] }), graph);
    const brief = renderElementBrief(located, 'make it bigger');
    expect(brief).toContain('could not be tied to a source file');
    expect(brief).toContain('rebuild the knowledge graph');
  });
});

describe('pruneInspectEvidence', () => {
  it('removes expired managed evidence without touching recent or unrelated files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aionui-inspect-'));
    const dir = join(root, '.omni', 'inspect');
    const oldShot = join(dir, 'shot-viewport-100.png');
    const recentVideo = join(dir, 'recording-200.mp4');
    const unrelated = join(dir, 'notes.txt');
    const now = Date.now();
    try {
      await mkdir(dir, { recursive: true });
      await Promise.all([writeFile(oldShot, 'old'), writeFile(recentVideo, 'recent'), writeFile(unrelated, 'keep')]);
      await utimes(oldShot, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000));

      expect(await pruneInspectEvidence(root, now)).toBe(1);
      await expect(access(oldShot)).rejects.toThrow();
      await expect(Promise.all([access(recentVideo), access(unrelated)])).resolves.toEqual([undefined, undefined]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('resolveFullPageSize', () => {
  it('uses the DOM scroll dimensions when layout metrics only report the viewport', () => {
    expect(resolveFullPageSize({ width: 1440, height: 900 }, { width: 1440, height: 6000 })).toEqual({
      width: 1440,
      height: 6000,
    });
  });
});

describe('captureAtIntrinsicZoom', () => {
  it('temporarily resets preview zoom and restores it after capture', async () => {
    const zooms: number[] = [];
    const contents = { getZoomFactor: () => 0.5, setZoomFactor: (factor: number) => zooms.push(factor) };

    await expect(captureAtIntrinsicZoom(contents as never, async () => 'captured')).resolves.toBe('captured');
    expect(zooms).toEqual([1, 0.5]);
  });

  it('restores preview zoom when capture fails', async () => {
    const zooms: number[] = [];
    const contents = { getZoomFactor: () => 0.6, setZoomFactor: (factor: number) => zooms.push(factor) };

    await expect(
      captureAtIntrinsicZoom(contents as never, async () => {
        throw new Error('capture failed');
      })
    ).rejects.toThrow('capture failed');
    expect(zooms).toEqual([1, 0.6]);
  });
});

describe('capturePageViewportPng', () => {
  it('captures CSS page pixels through CDP instead of the preview-card bitmap', async () => {
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { pageX: 12, pageY: 34, clientWidth: 1100.8, clientHeight: 700.9 } };
      }
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('page-png').toString('base64') };
      return {};
    });
    const capturePage = vi.fn();
    let attached = false;
    const attach = vi.fn(() => {
      attached = true;
    });
    const detach = vi.fn(() => {
      attached = false;
    });
    const contents = {
      debugger: { isAttached: () => attached, attach, detach, sendCommand },
      capturePage,
    };

    await expect(capturePageViewportPng(contents as never)).resolves.toEqual(Buffer.from('page-png'));
    expect(capturePage).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledWith(
      'Page.captureScreenshot',
      expect.objectContaining({
        clip: { x: 12, y: 34, width: 1100, height: 700, scale: 1 },
      })
    );
    expect(attach).toHaveBeenCalledWith('1.3');
    expect(detach).toHaveBeenCalledOnce();
  });

  it('falls back to Electron capture when CDP capture is unavailable', async () => {
    const png = Buffer.from('fallback-png');
    const contents = {
      debugger: {
        isAttached: () => false,
        attach: vi.fn(),
        detach: vi.fn(),
        sendCommand: vi.fn().mockRejectedValue(new Error('CDP unavailable')),
      },
      capturePage: vi.fn().mockResolvedValue({
        isEmpty: () => false,
        toPNG: () => png,
      }),
    };

    await expect(capturePageViewportPng(contents as never)).resolves.toEqual(png);
    expect(contents.capturePage).toHaveBeenCalledOnce();
  });
});

describe('renderMultiElementBrief visual evidence', () => {
  it('lists every screenshot and recording for the agent', () => {
    const brief = renderMultiElementBrief(
      [],
      'check the mobile layout',
      [
        { filePath: 'C:/repo/.omni/inspect/frame.png', mode: 'viewport' },
        { filePath: 'C:/repo/.omni/inspect/full.png', mode: 'fullPage' },
      ],
      [{ filePath: 'C:/repo/.omni/inspect/run.mp4', durationMs: 12_400 }]
    );

    expect(brief).toContain('> check the mobile layout');
    expect(brief).toContain('visible-frame: `C:/repo/.omni/inspect/frame.png`');
    expect(brief).toContain('full-page: `C:/repo/.omni/inspect/full.png`');
    expect(brief).toContain('12s: `C:/repo/.omni/inspect/run.mp4`');
  });

  it('returns an empty brief when there is no element or visual evidence', () => {
    expect(renderMultiElementBrief([], '')).toBe('');
  });
});
