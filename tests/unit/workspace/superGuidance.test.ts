/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the Super standing-instructions builder. These rules steer the
 * agent to the embedded `browser_*` tools instead of spawning sub-agents or
 * shelling out to the OS (the Windows `start` failure the user hit).
 */

import { describe, it, expect } from 'vitest';
import {
  BROWSER_CONTROL_MCP_NAME,
  SUPER_BROWSER_RULES,
  withSuperBrowserRules,
} from '@/renderer/pages/conversation/hooks/superGuidance';

describe('superGuidance', () => {
  it('exposes the canonical Browser-Control server name', () => {
    expect(BROWSER_CONTROL_MCP_NAME).toBe('aionui-browser-control');
  });

  it('rules forbid shelling out / sub-agents and point to the browser + editor tools', () => {
    expect(SUPER_BROWSER_RULES).toContain('browser_open');
    expect(SUPER_BROWSER_RULES).toContain('browser_list_tabs');
    expect(SUPER_BROWSER_RULES).toContain('browser_research');
    expect(SUPER_BROWSER_RULES).toContain('editor_open');
    expect(SUPER_BROWSER_RULES).toContain('editor_write');
    expect(SUPER_BROWSER_RULES).toMatch(/never spawn sub-agents/i);
    expect(SUPER_BROWSER_RULES).toMatch(/start/);
  });

  it('appends the block when there are no existing rules', () => {
    expect(withSuperBrowserRules(undefined)).toBe(SUPER_BROWSER_RULES);
    expect(withSuperBrowserRules('')).toBe(SUPER_BROWSER_RULES);
  });

  it('preserves existing rules and appends the Super block once (idempotent)', () => {
    const existing = 'You are a helpful agent.';
    const once = withSuperBrowserRules(existing);
    expect(once.startsWith(existing)).toBe(true);
    expect(once).toContain('Super capabilities (Super is ON)');

    // Re-applying must not duplicate the block.
    const twice = withSuperBrowserRules(once);
    expect(twice).toBe(once.trim());
    expect(twice.match(/Super capabilities \(Super is ON\)/g)?.length).toBe(1);
  });
});
