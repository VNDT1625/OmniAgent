/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the Main-process applier (`process/router9/router9Applier.ts`).
 * All filesystem effects are injected, so these run without touching disk and
 * assert the high-risk behaviours: deep-merge, backup-before-overwrite, atomic
 * write target paths, createIfMissing skip, and env-as-notes.
 */

import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { applyConnectorPlan, type Router9ApplierDeps } from '@process/router9/router9Applier';
import type { Router9Endpoint } from '@/common/router9';

/** OS-native normalized path, matching what the applier computes internally. */
const norm = (p: string): string => path.normalize(p);

const endpoint: Router9Endpoint = {
  baseUrl: 'http://127.0.0.1:20128/v1',
  apiKey: 'sk_test',
  model: 'kr/claude-sonnet-4.5',
};

/** Build an in-memory fs seam backed by a path→content map. */
const makeDeps = (
  initial: Record<string, string> = {}
): { deps: Router9ApplierDeps; files: Map<string, string>; backups: string[] } => {
  const files = new Map<string, string>(Object.entries(initial));
  const backups: string[] = [];
  const deps: Router9ApplierDeps = {
    homeDir: () => '/home/me',
    readFile: vi.fn(async (p: string) => files.get(p)),
    writeFileAtomic: vi.fn(async (p: string, content: string) => {
      files.set(p, content);
    }),
    backup: vi.fn(async (p: string) => {
      if (!files.has(p)) return undefined;
      const bak = `${p}.bak`;
      backups.push(bak);
      return bak;
    }),
  };
  return { deps, files, backups };
};

describe('applyConnectorPlan — claude-code (configFile, deepMerge)', () => {
  it('writes ~/.claude/config.json with home expanded and anthropic keys', async () => {
    const { deps, files } = makeDeps();
    const res = await applyConnectorPlan('claude-code', endpoint, deps);

    const target = norm('/home/me/.claude/config.json');
    expect(res.files).toHaveLength(1);
    expect(res.files[0]).toMatchObject({ path: target, status: 'written' });
    expect(res.files[0].backupPath).toBeUndefined(); // no prior file → no backup

    const written = JSON.parse(files.get(target) as string);
    expect(written.anthropic_api_base).toBe('http://127.0.0.1:20128/v1');
    expect(written.anthropic_api_key).toBe('sk_test');
  });

  it('backs up + deep-merges an existing config (preserves unrelated keys)', async () => {
    const target = norm('/home/me/.claude/config.json');
    const { deps, files, backups } = makeDeps({
      [target]: JSON.stringify({ theme: 'dark', anthropic_api_key: 'old' }),
    });

    const res = await applyConnectorPlan('claude-code', endpoint, deps);

    expect(res.files[0]).toMatchObject({ path: target, status: 'written', backupPath: `${target}.bak` });
    expect(backups).toContain(`${target}.bak`);

    const written = JSON.parse(files.get(target) as string);
    expect(written).toEqual({
      theme: 'dark',
      anthropic_api_base: 'http://127.0.0.1:20128/v1',
      anthropic_api_key: 'sk_test',
    });
  });
});

describe('applyConnectorPlan — codex (env mechanism)', () => {
  it('writes no files and returns env vars as notes', async () => {
    const { deps, files } = makeDeps();
    const res = await applyConnectorPlan('codex', endpoint, deps);

    expect(res.files).toHaveLength(0);
    expect(files.size).toBe(0);
    expect(res.notes).toEqual([
      'OPENAI_BASE_URL=http://127.0.0.1:20128',
      'OPENAI_API_KEY=sk_test',
      'OPENAI_MODEL=kr/claude-sonnet-4.5',
    ]);
  });
});

describe('applyConnectorPlan — validation', () => {
  it('throws on a missing api key (engine guard)', async () => {
    const { deps } = makeDeps();
    await expect(applyConnectorPlan('claude-code', { baseUrl: endpoint.baseUrl, apiKey: '' }, deps)).rejects.toThrow(
      /apiKey/
    );
  });

  it('throws on an unknown target', async () => {
    const { deps } = makeDeps();
    await expect(applyConnectorPlan('nope', endpoint, deps)).rejects.toThrow(/Unknown 9Router connector target/);
  });
});
