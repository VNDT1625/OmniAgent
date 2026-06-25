/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for traceContextBuilder — maps a RuntimeTrace to a ContextPack.
 */

import { describe, expect, it } from 'vitest';
import { buildTraceContext } from '@/process/ide/traceContextBuilder';
import type { RuntimeTrace } from '@/process/ide/quickTestTracer';
import type { KnowledgeGraph } from '@/process/ide/understandTypes';

const node = (id: string, layer: 'ui' | 'api' | 'service' | 'util' = 'util', summary = '') => ({
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
      line: 1,
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
    node('src/auth/LoginButton.tsx', 'ui', 'Login button component'),
    node('src/auth/authApi.ts', 'api', 'Auth API calls'),
    node('src/auth/useAuth.ts', 'service', 'Auth hook'),
    node('src/utils/logger.ts', 'util', 'Logger'),
  ],
  edges: [
    { from: 'src/auth/LoginButton.tsx', to: 'src/auth/useAuth.ts' },
    { from: 'src/auth/useAuth.ts', to: 'src/auth/authApi.ts' },
  ],
  tours: [],
  truncated: false,
  fileCount: 4,
};

const makeTrace = (overrides: Partial<RuntimeTrace> = {}): RuntimeTrace => ({
  platform: 'web',
  rootPath: '/repo',
  events: [],
  firstError: null,
  startedAt: 1000,
  stoppedAt: 2000,
  ...overrides,
});

describe('buildTraceContext', () => {
  it('maps a stack-trace URL to the matching graph node', () => {
    const trace = makeTrace({
      events: [
        {
          kind: 'exception',
          message: 'TypeError: Cannot read property',
          stack: 'TypeError\n  at http://localhost:3000/src/auth/authApi.ts:42',
          at: 1500,
        },
      ],
      firstError: {
        kind: 'exception',
        message: 'TypeError: Cannot read property',
        stack: 'TypeError\n  at http://localhost:3000/src/auth/authApi.ts:42',
        at: 1500,
      },
    });
    const pack = buildTraceContext(trace, graph);
    const ids = pack.slices.map((s) => s.path);
    expect(ids).toContain('src/auth/authApi.ts');
    expect(pack.slices.find((s) => s.path === 'src/auth/authApi.ts')?.reason).toBe('changed');
  });

  it('maps a network error URL to api/service layer nodes', () => {
    const trace = makeTrace({
      events: [{ kind: 'network', method: 'POST', url: 'http://localhost:3000/api/auth/login', status: 500, at: 1500 }],
      firstError: {
        kind: 'network',
        method: 'POST',
        url: 'http://localhost:3000/api/auth/login',
        status: 500,
        at: 1500,
      },
    });
    const pack = buildTraceContext(trace, graph);
    // authApi.ts is an api-layer node and its id contains "auth"
    const ids = pack.slices.map((s) => s.path);
    expect(ids.some((id) => id.includes('auth'))).toBe(true);
  });

  it('maps a DOM click selector to a UI component', () => {
    const trace = makeTrace({
      events: [{ kind: 'click', selector: 'button.LoginButton', text: 'Login', at: 1200 }],
    });
    const pack = buildTraceContext(trace, graph);
    const ids = pack.slices.map((s) => s.path);
    expect(ids).toContain('src/auth/LoginButton.tsx');
  });

  it('renders a human-readable brief with the error description', () => {
    const trace = makeTrace({
      events: [
        { kind: 'click', selector: 'button', text: 'Login', at: 1100 },
        { kind: 'exception', message: 'TypeError: null is not an object', stack: '', at: 1500 },
      ],
      firstError: { kind: 'exception', message: 'TypeError: null is not an object', stack: '', at: 1500 },
    });
    const pack = buildTraceContext(trace, graph);
    expect(pack.renderedContext).toContain('Quick Test trace');
    expect(pack.renderedContext).toContain('TypeError: null is not an object');
    expect(pack.renderedContext).toContain('Click');
  });

  it('returns an empty slices pack when no events match', () => {
    const trace = makeTrace({ events: [] });
    const pack = buildTraceContext(trace, graph);
    expect(pack.slices).toHaveLength(0);
    expect(pack.renderedContext).toContain('Quick Test trace');
  });

  it('suffix-matches a stack URL that is not an exact node id', () => {
    const stack = 'TypeError\n  at http://localhost:3000/auth/authApi.ts:10';
    const trace = makeTrace({
      events: [{ kind: 'exception', message: 'boom', stack, at: 1500 }],
      firstError: { kind: 'exception', message: 'boom', stack, at: 1500 },
    });
    const pack = buildTraceContext(trace, graph);
    // "auth/authApi.ts" is not a node id, but it is a suffix of "src/auth/authApi.ts".
    expect(pack.slices.some((s) => s.path === 'src/auth/authApi.ts')).toBe(true);
  });

  it('maps a failed network request (transport failure) to api/service nodes', () => {
    const trace = makeTrace({
      events: [{ kind: 'network', method: 'GET', url: 'http://localhost:3000/api/auth/session', status: 0, error: 'ECONN', at: 1500 }],
    });
    const pack = buildTraceContext(trace, graph);
    expect(pack.slices.some((s) => s.path.includes('auth'))).toBe(true);
  });

  it('maps a DOM input selector to a UI component', () => {
    const trace = makeTrace({
      events: [{ kind: 'input', selector: 'input.LoginButton', value: 'x', at: 1200 }],
    });
    const pack = buildTraceContext(trace, graph);
    expect(pack.slices.some((s) => s.path === 'src/auth/LoginButton.tsx')).toBe(true);
  });

  it('renders a network-error brief for a network firstError', () => {
    const netErr = { kind: 'network' as const, method: 'POST', url: 'http://localhost/api/x', status: 503, at: 1500 };
    const trace = makeTrace({ events: [netErr], firstError: netErr });
    const pack = buildTraceContext(trace, graph);
    expect(pack.renderedContext).toContain('Network error');
    expect(pack.renderedContext).toContain('503');
  });
});
