/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the 9Router connector engine — the pure layer that turns a
 * target tool + endpoint into an apply-able plan ("auto convert to the format
 * the app needs"). No Electron / network / filesystem involved.
 */

import { describe, expect, it } from 'vitest';
import { buildConnectorPlan, CONNECTOR_TARGETS, getConnectorTarget, toOrigin, toV1 } from '@/common/router9';
import type { Router9Endpoint } from '@/common/router9';

const endpoint: Router9Endpoint = {
  baseUrl: 'http://127.0.0.1:20128/v1',
  apiKey: 'sk_test_key',
  model: 'kr/claude-sonnet-4.5',
};

describe('url normalization', () => {
  it('toOrigin strips /v1 and trailing slashes (idempotent)', () => {
    expect(toOrigin('http://127.0.0.1:20128/v1')).toBe('http://127.0.0.1:20128');
    expect(toOrigin('http://127.0.0.1:20128/v1/')).toBe('http://127.0.0.1:20128');
    expect(toOrigin('http://127.0.0.1:20128')).toBe('http://127.0.0.1:20128');
  });

  it('toV1 appends a single /v1 (idempotent)', () => {
    expect(toV1('http://127.0.0.1:20128')).toBe('http://127.0.0.1:20128/v1');
    expect(toV1('http://127.0.0.1:20128/v1')).toBe('http://127.0.0.1:20128/v1');
    expect(toV1('http://127.0.0.1:20128/')).toBe('http://127.0.0.1:20128/v1');
  });
});

describe('registry', () => {
  it('exposes the requested CLI/IDE targets', () => {
    const ids = CONNECTOR_TARGETS.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining(['kiro', 'antigravity', 'claude-code', 'codex', 'cursor', 'cline', 'openclaw'])
    );
  });

  it('looks up a target by id', () => {
    expect(getConnectorTarget('kiro')?.label).toBe('Kiro');
    expect(getConnectorTarget('nope')).toBeUndefined();
  });
});

describe('buildConnectorPlan — validation', () => {
  it('throws on unknown target', () => {
    expect(() => buildConnectorPlan('ghost', endpoint)).toThrow(/Unknown 9Router connector target/);
  });

  it('throws when baseUrl is empty', () => {
    expect(() => buildConnectorPlan('kiro', { baseUrl: '  ', apiKey: 'k' })).toThrow(/baseUrl is required/);
  });

  it('throws when apiKey is empty', () => {
    expect(() => buildConnectorPlan('kiro', { baseUrl: 'http://x/v1', apiKey: '' })).toThrow(/apiKey is required/);
  });
});

describe('buildConnectorPlan — protocol/base-url shaping', () => {
  it('codex uses origin base url + OPENAI_* env vars', () => {
    const plan = buildConnectorPlan('codex', endpoint);
    expect(plan.baseUrl).toBe('http://127.0.0.1:20128');
    expect(plan.env).toEqual([
      { key: 'OPENAI_BASE_URL', value: 'http://127.0.0.1:20128' },
      { key: 'OPENAI_API_KEY', value: 'sk_test_key' },
      { key: 'OPENAI_MODEL', value: 'kr/claude-sonnet-4.5' },
    ]);
    expect(plan.files).toHaveLength(0);
  });

  it('kiro (manual) keeps /v1 and produces copy-paste fields only', () => {
    const plan = buildConnectorPlan('kiro', endpoint);
    expect(plan.baseUrl).toBe('http://127.0.0.1:20128/v1');
    expect(plan.env).toHaveLength(0);
    expect(plan.files).toHaveLength(0);
    expect(plan.fields).toEqual([
      { key: 'baseUrl', value: 'http://127.0.0.1:20128/v1' },
      { key: 'apiKey', value: 'sk_test_key' },
      { key: 'model', value: 'kr/claude-sonnet-4.5' },
    ]);
  });
});

describe('buildConnectorPlan — config files', () => {
  it('claude-code writes anthropic-style config with /v1 base', () => {
    const plan = buildConnectorPlan('claude-code', endpoint);
    expect(plan.files).toHaveLength(1);
    const file = plan.files[0];
    expect(file.path).toBe('~/.claude/config.json');
    expect(file.mergeStrategy).toBe('deepMerge');
    const parsed = JSON.parse(file.content) as Record<string, string>;
    expect(parsed.anthropic_api_base).toBe('http://127.0.0.1:20128/v1');
    expect(parsed.anthropic_api_key).toBe('sk_test_key');
  });

  it('openclaw writes a 9router provider block with the chosen model', () => {
    const plan = buildConnectorPlan('openclaw', endpoint);
    const file = plan.files[0];
    expect(file.path).toBe('~/.openclaw/openclaw.json');
    const parsed = JSON.parse(file.content) as {
      models: { providers: { '9router': { baseUrl: string; apiKey: string; api: string; models: { id: string }[] } } };
    };
    const provider = parsed.models.providers['9router'];
    expect(provider.baseUrl).toBe('http://127.0.0.1:20128/v1');
    expect(provider.api).toBe('openai-completions');
    expect(provider.models[0].id).toBe('kr/claude-sonnet-4.5');
  });

  it('openclaw falls back to a default model when none is given', () => {
    const plan = buildConnectorPlan('openclaw', { baseUrl: 'http://127.0.0.1:20128/v1', apiKey: 'k' });
    const parsed = JSON.parse(plan.files[0].content) as {
      models: { providers: { '9router': { models: { id: string }[] } } };
    };
    expect(parsed.models.providers['9router'].models[0].id).toBe('kr/claude-sonnet-4.5');
    // No model field in copy-paste fields when endpoint.model is absent.
    expect(plan.fields.find((f) => f.key === 'model')).toBeUndefined();
  });
});
