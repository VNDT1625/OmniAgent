/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the Omni External MCP Gateway session state machine.
 *
 * Pure in-RAM logic: clock and id generator are injected so we can assert on
 * deterministic session ids and force idle expiry without sleeping. The
 * bootstrap-result builder is also exercised against a captured state to lock
 * in its response shape (sessionId, tools allow/dangerous flags, policy).
 */

import { describe, expect, it } from 'vitest';
import { createOmniGatewayState } from '@/process/omni-gateway/omniGatewayState';
import { OMNI_DENIED_NATIVE_TOOLS, buildOmniBootstrapResult } from '@/process/omni-gateway/omniBootstrap';
import { OMNI_IDE_BASE_ALLOWLIST, OMNI_IDE_DANGEROUS_TOOLS } from '@/process/omni-gateway/omniIdeAllowlist';

const TTL_MS = 1000;

const newClock = (start = 0) => {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
};

const newIdGen = () => {
  let n = 0;
  return () => `s-${++n}`;
};

const newState = () => {
  const clock = newClock();
  const state = createOmniGatewayState({ now: clock.now, newId: newIdGen(), sessionTtlMs: TTL_MS });
  return { state, clock };
};

describe('omniGatewayState', () => {
  it('issues sessions with unique ids and stores rootPath + allowDangerous', () => {
    const { state } = newState();
    const a = state.issueSession({ rootPath: '/repo', allowDangerous: false });
    const b = state.issueSession({ rootPath: '/repo', allowDangerous: true });
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(state.getSession(a.sessionId)?.rootPath).toBe('/repo');
    expect(state.getSession(b.sessionId)?.allowDangerous).toBe(true);
  });

  it('expires sessions after the idle TTL', () => {
    const { state, clock } = newState();
    const session = state.issueSession({ rootPath: '/repo', allowDangerous: false });
    expect(state.getSession(session.sessionId)).toBeDefined();
    clock.advance(TTL_MS + 1);
    expect(state.getSession(session.sessionId)).toBeUndefined();
  });

  it('touch() refreshes lastSeenAt so a session survives an idle window', () => {
    const { state, clock } = newState();
    const session = state.issueSession({ rootPath: '/repo', allowDangerous: false });
    clock.advance(TTL_MS - 10);
    state.touch(session.sessionId);
    clock.advance(TTL_MS - 10);
    expect(state.getSession(session.sessionId)).toBeDefined();
  });

  it('clear() drops every live session', () => {
    const { state } = newState();
    state.issueSession({ rootPath: '/repo', allowDangerous: false });
    state.issueSession({ rootPath: '/other', allowDangerous: true });
    expect(state.snapshot()).toHaveLength(2);
    state.clear();
    expect(state.snapshot()).toHaveLength(0);
  });
});

describe('buildOmniBootstrapResult', () => {
  const baseInput = () => {
    const { state } = newState();
    return {
      state,
      rootPath: '/repo/AionUi',
      rules: ['rule-1', 'rule-2'] as const,
      planningEnabled: false,
      allowDangerous: false,
      baseAllowlist: OMNI_IDE_BASE_ALLOWLIST,
      dangerousTools: OMNI_IDE_DANGEROUS_TOOLS,
      serverInstructions: 'inst',
      sessionTtlMs: TTL_MS,
    };
  };

  it('returns a session id + workspace name derived from the rootPath basename', () => {
    const result = buildOmniBootstrapResult(baseInput());
    expect(result.sessionId).toBe('s-1');
    expect(result.workspace.rootPath).toBe('/repo/AionUi');
    expect(result.workspace.name).toBe('AionUi');
  });

  it('marks dangerous tools as not allowed when the opt-in is off', () => {
    const result = buildOmniBootstrapResult(baseInput());
    const dangerous = result.tools.find((t) => t.name === 'ide_command');
    expect(dangerous?.dangerous).toBe(true);
    expect(dangerous?.allowed).toBe(false);
    const safe = result.tools.find((t) => t.name === 'ide_search');
    expect(safe?.dangerous).toBe(false);
    expect(safe?.allowed).toBe(true);
  });

  it('flips dangerous tools to allowed when the opt-in is on', () => {
    const result = buildOmniBootstrapResult({ ...baseInput(), allowDangerous: true });
    const dangerous = result.tools.find((t) => t.name === 'db_query');
    expect(dangerous?.allowed).toBe(true);
    expect(result.policy.allowDangerous).toBe(true);
  });

  it('includes the canonical denied native tools list', () => {
    const result = buildOmniBootstrapResult(baseInput());
    for (const name of OMNI_DENIED_NATIVE_TOOLS) {
      expect(result.policy.deniedNativeTools).toContain(name);
    }
  });

  it('embeds the workspace primer into activeGuide', () => {
    const result = buildOmniBootstrapResult(baseInput());
    expect(result.activeGuide).toContain('## IDE workspace guide');
    expect(result.activeGuide).toContain('Workspace root: /repo/AionUi');
    expect(result.activeGuide).toContain('## Project rules');
    expect(result.activeGuide).toContain('- rule-1');
    expect(result.activeGuide).toContain(result.sessionId);
  });
});
