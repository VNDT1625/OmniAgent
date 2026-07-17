/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { BoundedSessionPool } from '../../../packages/desktop/src/process/experimentalCore/sessionPool';
import {
  classifyAgentFailure,
  isRetryManagedError,
  withPersistentAgentRetry,
} from '../../../packages/desktop/src/process/agentRuntime/retryPolicy';

import {
  normalizeTomnyStreamEvent,
  parseTomnyModelCatalog,
  sanitizeTomnyToolDetail,
  tomnyMcpInjectionCommand,
  tomnyNativeToolDenialReason,
  tomnyProvidedToolResultCommand,
  translateNativeTomnyTool,
  tomnyStrictProjectArgs,
  tomnyStrictToolsConfig,
  tomnyToolAccessForPermission,
  tomnyModeForPermission,
  tomnyModelArgs,
  tomnyRuntimeKey,
  waitForTomnyTurn,
} from '../../../packages/desktop/src/process/experimentalCore/adapters/tomnyCoreAdapter';

describe('Tomny JSON stream adapter', () => {
  it('never exposes typed credentials in permission details', () => {
    const detail = sanitizeTomnyToolDetail('browser_type', {
      selector: '#password',
      text: 'super-secret-password',
    });

    expect(detail).toContain('#password');
    expect(detail).not.toContain('super-secret-password');
    expect(detail).toContain('[REDACTED]');
  });

  it('redacts credential-shaped fields while preserving non-secret approval context', () => {
    const detail = sanitizeTomnyToolDetail('some_tool', {
      endpoint: 'https://example.test',
      apiKey: 'sk-example-secret-123456',
      nested: { token: 'private-token', count: 2 },
    });

    expect(detail).toContain('https://example.test');
    expect(detail).toContain('"count":2');
    expect(detail).not.toContain('sk-example-secret-123456');
    expect(detail).not.toContain('private-token');
  });

  it('maps text and informational events into the transport-neutral contract', () => {
    expect(normalizeTomnyStreamEvent({ type: 'text_delta', text: 'Hello' })).toEqual({
      type: 'delta',
      text: 'Hello',
      mode: 'append',
    });
    expect(normalizeTomnyStreamEvent({ type: 'info', message: 'Retrying' })).toEqual({
      type: 'step',
      text: 'Retrying',
    });
    expect(normalizeTomnyStreamEvent({ type: 'thinking', text: 'Checking files' })).toEqual({
      type: 'thinking',
      text: 'Checking files',
    });
    expect(normalizeTomnyStreamEvent({ type: 'info', message: 'Tool call: Glob' })).toEqual({
      type: 'tool-call',
      tool: 'Glob',
      text: 'Tool call: Glob',
      phase: 'requested',
    });
    expect(normalizeTomnyStreamEvent({ type: 'info', message: '[ExecCommand error] failed' })).toEqual({
      type: 'tool-result',
      tool: 'ExecCommand',
      outcome: 'error',
      text: 'failed',
    });
    expect(normalizeTomnyStreamEvent({ type: 'tool_running', tool_name: 'Read' })).toEqual({
      type: 'tool-call',
      tool: 'Read',
      text: 'Tomny is running Read',
      phase: 'running',
    });
  });

  it('ignores lifecycle events that are handled by the process session', () => {
    expect(normalizeTomnyStreamEvent({ type: 'ready' })).toBeNull();
    expect(normalizeTomnyStreamEvent({ type: 'stream_end' })).toBeNull();
  });

  it('keeps provider worklog text and every emitted detail field without summarizing it', () => {
    expect(
      normalizeTomnyStreamEvent({
        type: 'thinking',
        text: 'Planning Vietnamese support inspection',
        intent: 'Trace the complete event path.',
        reason: 'Need to distinguish provider output from renderer formatting.',
        action: 'Search the core adapter\nand UI event renderer.',
        input: { query: 'thinking step tool-call' },
        output: { matches: 4 },
        next_step: 'Read the matching adapter code before editing.',
        detail: 'Provider detail is preserved verbatim.',
      })
    ).toEqual({
      type: 'thinking',
      text: [
        'Planning Vietnamese support inspection',
        'Intent: Trace the complete event path.',
        'Reason:\nNeed to distinguish provider output from renderer formatting.',
        'Action:\nSearch the core adapter\nand UI event renderer.',
        'Input:\n{\n  "query": "thinking step tool-call"\n}',
        'Output:\n{\n  "matches": 4\n}',
        'Next:\nRead the matching adapter code before editing.',
        'Detail:\nProvider detail is preserved verbatim.',
      ].join('\n\n'),
    });
  });

  it('does not truncate long provider thinking or detailed step fields', () => {
    const fullThinking = `Evidence:\n${'x'.repeat(16_000)}`;
    expect(normalizeTomnyStreamEvent({ type: 'thinking', text: fullThinking })).toEqual({
      type: 'thinking',
      text: fullThinking,
    });
    expect(
      normalizeTomnyStreamEvent({
        type: 'info',
        message: 'Inspecting provider response',
        reason: 'The full worklog must reach the UI.',
        detail: 'Detailed observation',
      })
    ).toEqual({
      type: 'step',
      text: [
        'Inspecting provider response',
        'Reason:\nThe full worklog must reach the UI.',
        'Detail:\nDetailed observation',
      ].join('\n\n'),
    });
  });

  it('treats null, undefined, and whitespace-only worklog fields as absent', () => {
    expect(normalizeTomnyStreamEvent({ type: 'thinking', text: null, detail: undefined })).toBeNull();
    expect(normalizeTomnyStreamEvent({ type: 'info', message: '', reason: '   ' })).toBeNull();
    expect(normalizeTomnyStreamEvent({ type: 'text_delta', text: null })).toBeNull();
  });

  it('preserves provider whitespace in response deltas and thinking text', () => {
    expect(normalizeTomnyStreamEvent({ type: 'text_delta', text: ' next' })).toEqual({
      type: 'delta',
      text: ' next',
      mode: 'append',
    });
    expect(normalizeTomnyStreamEvent({ type: 'thinking', text: '  line one\nline two  ' })).toEqual({
      type: 'thinking',
      text: '  line one\nline two  ',
    });
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
    const rejected = expect(waiting).rejects.toThrow('produced no activity');
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(onTimeout).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('keeps a Tomny turn alive while stream activity continues', async () => {
    vi.useFakeTimers();
    let lastActivityAt = Date.now();
    const onTimeout = vi.fn();
    const waiting = waitForTomnyTurn(new Promise<void>(() => undefined), onTimeout, 50, () => lastActivityAt);

    await vi.advanceTimersByTimeAsync(40);
    lastActivityAt = Date.now();
    await vi.advanceTimersByTimeAsync(40);
    expect(onTimeout).not.toHaveBeenCalled();

    const rejected = expect(waiting).rejects.toThrow('produced no activity');
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(onTimeout).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('injects the Tomny tool MCP over SSE before the first message', () => {
    expect(tomnyMcpInjectionCommand('http://127.0.0.1:1234/sse')).toEqual({
      type: 'add_mcp_server',
      name: 'tomny-tools',
      transport: 'sse',
      url: 'http://127.0.0.1:1234/sse',
    });
  });

  it('allows safe Tomny reads but denies mutation in read-only mode', () => {
    expect(tomnyToolAccessForPermission('read-only', 'tomny_read', 'mcp')).toBe('approve');
    expect(tomnyToolAccessForPermission('read-only', 'tomny_visual_analyze', 'mcp')).toBe('approve');
    expect(tomnyToolAccessForPermission('read-only', 'tomny_team_status', 'mcp')).toBe('approve');
    expect(tomnyToolAccessForPermission('read-only', 'tomny_team_edit', 'mcp')).toBe('deny');
    expect(tomnyToolAccessForPermission('read-only', 'tomny_command', 'mcp')).toBe('deny');

    expect(tomnyToolAccessForPermission('read-only', 'ide_memory_set_secret', 'mcp')).toBe('deny');
    expect(tomnyToolAccessForPermission('read-only', 'db_query', 'mcp')).toBe('deny');
  });

  it('prompts for workspace writes and auto-approves full-access Tomny requests', () => {
    expect(tomnyToolAccessForPermission('workspace-write', 'tomny_team_edit', 'mcp')).toBe('prompt');
    expect(tomnyToolAccessForPermission('full-access', 'tomny_command', 'mcp')).toBe('approve');
  });

  it('blocks native filesystem and shell tools even when full access is selected', () => {
    for (const nativeTool of ['Read', 'Write', 'Edit', 'ExecCommand', 'Grep', 'Glob', 'Spawn']) {
      expect(tomnyToolAccessForPermission('workspace-write', nativeTool, 'info')).toBe('deny');
      expect(tomnyToolAccessForPermission('full-access', nativeTool, 'exec')).toBe('deny');
    }
    expect(tomnyNativeToolDenialReason('Read')).toContain('tomny_read');
    expect(tomnyNativeToolDenialReason('ExecCommand')).toContain('tomny_command');
    expect(tomnyNativeToolDenialReason('Edit')).toContain('tomny_team_edit');
  });

  it('translates safe native tool schemas into Tomny MCP calls', () => {
    expect(translateNativeTomnyTool('Read', { file_path: 'C:/repo/src/a.ts', offset: 4, limit: 3 }, 'C:/repo')).toEqual(
      {
        name: 'tomny_read',
        arguments: { filePath: 'C:/repo/src/a.ts', from: 5, to: 7, lineNumbers: true },
      }
    );
    expect(translateNativeTomnyTool('Grep', { pattern: 'hello', path: 'src', glob: '*.ts' }, 'C:/repo')).toEqual({
      name: 'tomny_search',
      arguments: {
        rootPath: expect.stringMatching(/C:[\\/]repo[\\/]src/u),
        pattern: 'hello',
        glob: '*.ts',
        regex: true,
      },
    });
    expect(translateNativeTomnyTool('Glob', { pattern: '**/*.ts' }, 'C:/repo')).toEqual({
      name: 'tomny_glob',
      arguments: { dir: 'C:/repo', pattern: '**/*.ts', recursive: true },
    });
    expect(translateNativeTomnyTool('ExecCommand', { cmd: 'bun test', timeout: 5000 }, 'C:/repo')).toEqual({
      name: 'tomny_command',
      arguments: { rootPath: 'C:/repo', command: 'bun test', cwd: 'C:/repo', timeoutMs: 5000 },
    });
  });

  it('does not auto-translate sensitive or semantically incompatible native tools', () => {
    expect(translateNativeTomnyTool('Write', { file_path: 'C:/repo/a.ts', content: 'x' }, 'C:/repo')).toBeNull();
    expect(translateNativeTomnyTool('Edit', {}, 'C:/repo')).toBeNull();
    expect(translateNativeTomnyTool('Spawn', {}, 'C:/repo')).toBeNull();
    expect(translateNativeTomnyTool('ExecCommand', { cmd: 'dir', shell: 'cmd' }, 'C:/repo')).toBeNull();
  });

  it('returns translated results through the host-result protocol command', () => {
    expect(tomnyProvidedToolResultCommand('call-1', 'translated output', false, 'tomny_read')).toEqual({
      type: 'tool_result',
      call_id: 'call-1',
      content: 'translated output',
      is_error: false,
      tool_name: 'tomny_read',
    });
  });

  it('keeps Tomny in host-controlled mode for every shared permission policy', () => {
    expect(tomnyModeForPermission('read-only')).toBe('default');
    expect(tomnyModeForPermission('workspace-write')).toBe('default');
    expect(tomnyModeForPermission('full-access')).toBe('default');
  });

  it('starts the CLI with an empty native auto-approval list', () => {
    expect(tomnyStrictToolsConfig).toContain('auto_approve = false');
    expect(tomnyStrictToolsConfig).toContain('allow_list = []');
    expect(tomnyStrictProjectArgs('C:/runtime/tomny-tools')).toEqual(['--project-dir', 'C:/runtime/tomny-tools']);
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

describe('persistent agent retry policy', () => {
  it('retries provider overload, network stalls, and unexpected process exits', () => {
    for (const error of [
      Object.assign(new Error('Too many requests'), { status: 429 }),
      new Error('Tomny produced no activity for 90s'),
      new Error('tomny exited with code 1'),
      new Error('HTTP 503 service unavailable'),
      new Error('500 Internal Server Error'),
      new Error('All API keys are busy'),
      new Error('RESOURCE_EXHAUSTED: Kiro is throttling requests'),
    ]) {
      expect(classifyAgentFailure(error)).toMatchObject({ kind: 'transient', retry: true });
    }
  });

  it('does not retry failures that require user or configuration changes', () => {
    const cases = [
      ['Maximum context length exceeded', 'context'],
      ['Invalid API key', 'auth'],
      ['insufficient_quota: out of credits', 'quota'],
      ['Model is not configured', 'configuration'],
      ['Failed to start tomny: spawn EACCES', 'configuration'],
      ['Tool Read failed', 'tool'],
      ['Denied by user', 'permission'],
      ['The request was cancelled', 'cancelled'],
    ] as const;
    for (const [message, kind] of cases) {
      expect(classifyAgentFailure(new Error(message))).toMatchObject({ kind, retry: false });
    }
  });

  it('retries in batches of five, waits fifteen seconds, and keeps one logical output', async () => {
    const operation = vi.fn(async (attempt: number) => {
      if (attempt <= 6) throw Object.assign(new Error('provider overloaded'), { status: 429 });
      return 'completed';
    });
    const onBeforeRetry = vi.fn();
    const onStatus = vi.fn();
    const sleep = vi.fn(async () => undefined);

    await expect(
      withPersistentAgentRetry({
        operation,
        signal: new AbortController().signal,
        onBeforeRetry,
        onStatus,
        sleep,
      })
    ).resolves.toBe('completed');

    expect(operation).toHaveBeenCalledTimes(7);
    expect(onBeforeRetry).toHaveBeenCalledTimes(6);
    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ batch: 2, nextAttemptInBatch: 1, remainingMs: 15_000 })
    );
    expect(sleep).toHaveBeenCalledTimes(6);
  });

  it('stops an endless retry batch immediately when the user aborts', async () => {
    const controller = new AbortController();
    const sleep = vi.fn(async () => {
      controller.abort();
    });
    const pending = withPersistentAgentRetry({
      operation: async () => {
        throw Object.assign(new Error('HTTP 429'), { status: 429 });
      },
      signal: controller.signal,
      sleep,
    });

    const error = await pending.catch((reason: unknown) => reason);
    expect(isRetryManagedError(error)).toBe(true);
    expect(error).toMatchObject({ message: 'The request was cancelled.' });
  });

  it('returns permanent errors without a second provider call', async () => {
    const operation = vi.fn(async () => {
      throw new Error('Maximum context length exceeded');
    });
    const error = await withPersistentAgentRetry({
      operation,
      signal: new AbortController().signal,
    }).catch((reason: unknown) => reason);

    expect(operation).toHaveBeenCalledOnce();
    expect(isRetryManagedError(error)).toBe(true);
  });

  it('removes the abort listener after a retry delay resolves', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const operation = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error('HTTP 429'), { status: 429 }))
      .mockResolvedValue('completed');
    const pending = withPersistentAgentRetry({
      operation,
      signal: controller.signal,
      retryDelayMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBe('completed');
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    vi.useRealTimers();
  });
});
