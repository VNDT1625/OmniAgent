/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { BoundedSessionPool } from '../../../packages/desktop/src/process/experimentalCore/sessionPool';

import {
  normalizeTomnyStreamEvent,
  parseTomnyModelCatalog,
  tomnyModeForPermission,
  tomnyModelArgs,
  tomnyRuntimeKey,
  waitForTomnyTurn,
} from '../../../packages/desktop/src/process/experimentalCore/tomnyCoreAdapter';

describe('Tomny JSON stream adapter', () => {
  it('maps text and informational events into the transport-neutral contract', () => {
    expect(normalizeTomnyStreamEvent({ type: 'text_delta', text: 'Hello' })).toEqual({
      type: 'delta',
      text: 'Hello',
      mode: 'append',
    });
    expect(normalizeTomnyStreamEvent({ type: 'info', message: 'Retrying' })).toEqual({
      type: 'status',
      text: 'Retrying',
    });
    expect(normalizeTomnyStreamEvent({ type: 'thinking', text: 'Checking files' })).toEqual({
      type: 'status',
      text: 'Checking files',
    });
  });

  it('ignores lifecycle events that are handled by the process session', () => {
    expect(normalizeTomnyStreamEvent({ type: 'ready' })).toBeNull();
    expect(normalizeTomnyStreamEvent({ type: 'stream_end' })).toBeNull();
  });

  it('discovers the default model and named profiles from Tomny config', () => {
    const models = parseTomnyModelCatalog(`
[default]
provider = "openai"
model = "gpt-5.6"

[profiles.fast]
provider = "openai"
model = "gpt-5.5"

[profiles.local]
provider = "ollama"
model = "qwen3:30b"
`);

    expect(models).toEqual([
      {
        key: 'provider:openai:gpt-5.6',
        modelId: 'gpt-5.6',
        label: 'gpt-5.6 (openai)',
        providerId: 'openai',
        isDefault: true,
      },
      {
        key: 'profile:fast',
        modelId: 'gpt-5.5',
        label: 'gpt-5.5 (fast)',
        providerId: 'openai',
        isDefault: false,
      },
      {
        key: 'profile:local',
        modelId: 'qwen3:30b',
        label: 'qwen3:30b (local)',
        providerId: 'ollama',
        isDefault: false,
      },
    ]);
  });

  it('uses Tomny provider defaults without requiring the legacy core catalog', () => {
    expect(parseTomnyModelCatalog('[default]\nprovider = "anthropic"')).toEqual([
      expect.objectContaining({
        key: 'provider:anthropic:claude-sonnet-4-20250514',
        modelId: 'claude-sonnet-4-20250514',
        isDefault: true,
      }),
    ]);
    expect(parseTomnyModelCatalog('', { PROVIDER: 'openai', MODEL: 'gpt-env' })).toEqual([
      expect.objectContaining({
        key: 'provider:openai:gpt-env',
        modelId: 'gpt-env',
        isDefault: true,
      }),
    ]);
  });

  it('rejects a stalled Tomny turn instead of waiting forever', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const waiting = waitForTomnyTurn(new Promise<void>(() => undefined), onTimeout, 50);
    const rejected = expect(waiting).rejects.toThrow('did not complete within');
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(onTimeout).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('maps the shared permission policy to Tomny native modes', () => {
    expect(tomnyModeForPermission('read-only')).toBe('default');
    expect(tomnyModeForPermission('workspace-write')).toBe('auto_edit');
    expect(tomnyModeForPermission('full-access')).toBe('yolo');
  });

  it('turns catalog keys into safe CLI arguments and rejects malformed config', () => {
    expect(tomnyModelArgs('profile:fast')).toEqual(['--profile', 'fast']);
    expect(tomnyModelArgs('provider:openai:gpt-5.6')).toEqual(['--provider', 'openai', '--model', 'gpt-5.6']);
    expect(parseTomnyModelCatalog('[broken')).toEqual([]);
  });

  it('reuses one lightweight runtime when only model or permission changes', () => {
    const identity = { targetId: 'tomny', workspace: 'C:/work' };
    expect(tomnyRuntimeKey({ ...identity, modelKey: 'provider:openai:gpt-5.5', permissionMode: 'read-only' })).toBe(
      tomnyRuntimeKey({ ...identity, modelKey: 'provider:openai:gpt-5.6', permissionMode: 'full-access' })
    );
    expect(tomnyRuntimeKey({ ...identity, modelKey: 'app-provider:first:gpt-5.6' })).not.toBe(
      tomnyRuntimeKey({ ...identity, modelKey: 'app-provider:second:gpt-5.6' })
    );
  });

  it('deduplicates concurrent startup and evicts the least-recent idle session', async () => {
    let now = 0;
    const pool = new BoundedSessionPool({ maxSessions: 2, now: () => now });
    const makeSession = () => ({ isBusy: () => false, dispose: vi.fn() });
    const first = makeSession();
    const factory = vi.fn().mockResolvedValue(first);
    const [left, right] = await Promise.all([pool.getOrCreate('a', factory), pool.getOrCreate('a', factory)]);
    now = 1;
    await pool.getOrCreate('b', async () => makeSession());
    now = 2;
    await pool.getOrCreate('c', async () => makeSession());

    expect(left).toBe(right);
    expect(factory).toHaveBeenCalledOnce();
    expect(first.dispose).toHaveBeenCalledOnce();
  });

  it('does not let a stale process generation invalidate its replacement', async () => {
    const pool = new BoundedSessionPool();
    const oldSession = { isBusy: () => false, dispose: vi.fn() };
    const newSession = { isBusy: () => false, dispose: vi.fn() };
    await pool.getOrCreate('same', async () => oldSession);
    pool.invalidate('same', oldSession);
    await pool.getOrCreate('same', async () => newSession);

    expect(pool.invalidate('same', oldSession)).toBe(false);
    expect(pool.size).toBe(1);
  });
});
