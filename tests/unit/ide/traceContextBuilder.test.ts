/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
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

  it('annotates the interaction line with the mapped component file:line and what it uses', () => {
    const trace = makeTrace({
      events: [{ kind: 'click', selector: 'button.LoginButton', text: 'Login', at: 1200 }],
    });
    const pack = buildTraceContext(trace, graph);
    // The raw selector is still shown…
    expect(pack.renderedContext).toContain('Click: `button.LoginButton`');
    // …but now followed by the concrete entry point (file:line + symbol)…
    expect(pack.renderedContext).toContain('↳ `src/auth/LoginButton.tsx:1` LoginButton()');
    // …and the modules that component touches (outgoing graph edges).
    expect(pack.renderedContext).toContain('uses: src/auth/useAuth.ts');
  });

  it('annotates relevant files with their primary symbol line and what they use', () => {
    const trace = makeTrace({
      events: [{ kind: 'click', selector: 'button.LoginButton', text: 'Login', at: 1200 }],
    });
    const pack = buildTraceContext(trace, graph);
    // The relevant-files list carries file:line + uses, not a bare path.
    expect(pack.renderedContext).toContain('`src/auth/LoginButton.tsx:1` (ui)');
    expect(pack.renderedContext).toContain('uses: src/auth/useAuth.ts');
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

  it('frames a clean trace as a flow review, not a bug fix (no error captured)', () => {
    const trace = makeTrace({
      events: [{ kind: 'click', selector: 'button.LoginButton', text: 'Login', at: 1200 }],
      firstError: null,
    });
    const pack = buildTraceContext(trace, graph);
    // No error: the brief must not tell the agent to "fix the bug" — it should
    // frame the trace as a flow to review (matches "No error detected").
    expect(pack.renderedContext).toContain('No error detected');
    expect(pack.renderedContext).toContain('reviewing the flow');
    expect(pack.renderedContext).not.toContain('fixing the bug');
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
      events: [
        {
          kind: 'network',
          method: 'GET',
          url: 'http://localhost:3000/api/auth/session',
          status: 0,
          error: 'ECONN',
          at: 1500,
        },
      ],
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

  it('maps V8 coverage functions to their exact graph nodes (strongest signal)', () => {
    const trace = makeTrace({
      events: [{ kind: 'click', selector: 'button', text: 'Buy', at: 1100 }],
      coverage: [
        { file: 'src/auth/authApi.ts', functionName: 'login', line: 42, callCount: 5 },
        { file: 'src/utils/logger.ts', functionName: 'log', line: 8, callCount: 12 },
      ],
    });
    const pack = buildTraceContext(trace, graph);
    const ids = pack.slices.map((s) => s.path);
    // Both executed files surface as suspects, even with no error thrown.
    expect(ids).toContain('src/auth/authApi.ts');
    expect(ids).toContain('src/utils/logger.ts');
  });

  it('lists the executed functions (which code ran) in the rendered brief', () => {
    const trace = makeTrace({
      events: [{ kind: 'click', selector: 'button', text: 'Buy', at: 1100 }],
      coverage: [{ file: 'src/auth/authApi.ts', functionName: 'login', line: 42, callCount: 5 }],
    });
    const pack = buildTraceContext(trace, graph);
    expect(pack.renderedContext).toContain('Code that actually ran');
    expect(pack.renderedContext).toContain('src/auth/authApi.ts:42');
    expect(pack.renderedContext).toContain('login()');
  });

  it('suffix-matches a coverage file that is not an exact node id', () => {
    const trace = makeTrace({
      coverage: [{ file: 'auth/authApi.ts', functionName: 'login', line: 1, callCount: 1 }],
    });
    const pack = buildTraceContext(trace, graph);
    expect(pack.slices.some((s) => s.path === 'src/auth/authApi.ts')).toBe(true);
  });

  it('renders a network-error brief for a network firstError', () => {
    const netErr = { kind: 'network' as const, method: 'POST', url: 'http://localhost/api/x', status: 503, at: 1500 };
    const trace = makeTrace({ events: [netErr], firstError: netErr });
    const pack = buildTraceContext(trace, graph);
    expect(pack.renderedContext).toContain('Network error');
    expect(pack.renderedContext).toContain('503');
  });

  it('boosts the pre-error interaction coverage above the session-wide set', () => {
    // Two clicks: the FIRST ran logger (innocent), the SECOND (right before the
    // error) ran authApi — the real suspect. Per-interaction coverage is on each
    // click; the session total lists both.
    const click1 = {
      kind: 'click' as const,
      selector: 'button',
      text: 'A',
      at: 1100,
      coverage: [{ file: 'src/utils/logger.ts', functionName: 'log', line: 3, callCount: 1 }],
    };
    const click2 = {
      kind: 'click' as const,
      selector: 'button',
      text: 'B',
      at: 1200,
      coverage: [{ file: 'src/auth/authApi.ts', functionName: 'login', line: 42, callCount: 1 }],
    };
    const err = { kind: 'exception' as const, message: 'boom', stack: '', at: 1300 };
    const trace = makeTrace({
      events: [click1, click2, err],
      firstError: err,
      coverage: [
        { file: 'src/utils/logger.ts', functionName: 'log', line: 3, callCount: 1 },
        { file: 'src/auth/authApi.ts', functionName: 'login', line: 42, callCount: 1 },
      ],
    });
    const pack = buildTraceContext(trace, graph);
    // The pre-error file outranks the innocent one (higher score → earlier slice).
    const authIdx = pack.slices.findIndex((s) => s.path === 'src/auth/authApi.ts');
    const logIdx = pack.slices.findIndex((s) => s.path === 'src/utils/logger.ts');
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(authIdx).toBeLessThan(logIdx);
    // The brief calls out the action that broke.
    expect(pack.renderedContext).toContain('Code that ran during the action that broke');
  });
});
