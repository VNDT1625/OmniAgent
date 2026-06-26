/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for elementInspectorLocator — the pure mapping core behind Quick
 * Test's visual element picker. Maps a PickedElement (DOM snapshot + optional
 * React fiber source) to the code that renders it, and renders an agent brief.
 */

import { describe, expect, it } from 'vitest';
import { locateElement, renderElementBrief, type PickedElement } from '@/process/ide/elementInspectorLocator';
import type { KnowledgeGraph } from '@/process/ide/understandTypes';

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

  it('handles a null graph gracefully (no crash, none)', () => {
    const located = locateElement(makeElement(), null);
    expect(located.resolvedBy).toBe('none');
    expect(located.file).toBeNull();
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
