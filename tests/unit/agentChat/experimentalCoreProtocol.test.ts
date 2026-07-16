/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  mapAcpSessionModels,
  resolveAcpPermission,
} from '../../../packages/desktop/src/process/experimentalCore/acpCoreAdapter';
import { codexSandboxForPermission } from '../../../packages/desktop/src/process/experimentalCore/codexAppServerAdapter';
import {
  buildExperimentalSessionKey,
  classifyExperimentalTarget,
  extractExperimentalTerminalError,
  normalizeTransportMessage,
  parseExperimentalHandshakeModels,
} from '../../../packages/desktop/src/process/experimentalCore/experimentalCoreProtocol';

describe('experimental core protocol', () => {
  it.each([
    [{ agent_type: 'aionrs', agent_source: 'builtin' }, 'builtin'],
    [{ agent_type: 'acp', agent_source: 'internal' }, 'acp'],
    [{ agent_type: 'acp', agent_source: 'custom' }, 'cli'],
    [{ agent_type: 'remote', agent_source: 'custom' }, 'remote'],
  ] as const)('classifies %o as %s', (agent, expected) => {
    expect(classifyExperimentalTarget(agent)).toBe(expected);
  });

  it('normalizes string and object content into append deltas', () => {
    expect(normalizeTransportMessage({ type: 'content', data: 'Hel' })).toEqual({
      type: 'delta',
      text: 'Hel',
      mode: 'append',
    });
    expect(normalizeTransportMessage({ type: 'text', data: { content: 'lo' } })).toEqual({
      type: 'delta',
      text: 'lo',
      mode: 'append',
    });
  });

  it('preserves replacement semantics from the transport', () => {
    expect(normalizeTransportMessage({ type: 'content', data: { content: 'complete', replace: true } })).toEqual({
      type: 'delta',
      text: 'complete',
      mode: 'replace',
    });
  });

  it('maps progress and errors without exposing raw backend shapes', () => {
    expect(
      normalizeTransportMessage({ type: 'thought', data: { subject: 'Planning', description: 'Reading' } })
    ).toEqual({
      type: 'status',
      text: 'Planning - Reading',
    });
    expect(normalizeTransportMessage({ type: 'error', data: { message: 'transport failed' } })).toEqual({
      type: 'error',
      text: 'transport failed',
    });
  });

  it('ignores transport-only lifecycle frames', () => {
    expect(normalizeTransportMessage({ type: 'start', data: null })).toBeNull();
    expect(normalizeTransportMessage({ type: 'finish', data: null })).toBeNull();
  });
  it('maps shared permission modes to Codex sandboxes', () => {
    expect(codexSandboxForPermission('read-only')).toBe('read-only');
    expect(codexSandboxForPermission('workspace-write')).toBe('workspace-write');
    expect(codexSandboxForPermission('full-access')).toBe('danger-full-access');
  });

  it('enforces read-only, prompted write, and full-access ACP decisions', async () => {
    const params = {
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1', title: 'Run command', rawInput: { command: 'bun test' } },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    } as Parameters<typeof resolveAcpPermission>[0];
    const request = vi.fn().mockResolvedValue(true);

    await expect(resolveAcpPermission(params, { mode: 'read-only', request })).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' },
    });
    await expect(resolveAcpPermission(params, { mode: 'workspace-write', request })).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(request).toHaveBeenCalledWith({
      tool: 'Run command',
      detail: JSON.stringify({ command: 'bun test' }),
    });
    await expect(resolveAcpPermission(params, { mode: 'full-access', request })).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-always' },
    });
  });

  it('reuses a stable session identity for the same target, workspace, and model', () => {
    const identity = { targetId: 'codex', workspace: 'C:/workspace', modelKey: 'gpt-5.5/medium' };
    expect(buildExperimentalSessionKey(identity)).toBe(buildExperimentalSessionKey(identity));
    expect(buildExperimentalSessionKey({ ...identity, modelKey: 'gpt-5.5/low' })).not.toBe(
      buildExperimentalSessionKey(identity)
    );
    expect(buildExperimentalSessionKey({ ...identity, permissionMode: 'read-only' })).not.toBe(
      buildExperimentalSessionKey(identity)
    );
  });

  it('keeps session identity fields unambiguous when values contain separators', () => {
    expect(buildExperimentalSessionKey({ targetId: 'a|b', workspace: 'c', modelKey: '' })).not.toBe(
      buildExperimentalSessionKey({ targetId: 'a', workspace: 'b|c', modelKey: '' })
    );
  });

  it('maps ACP session model capabilities without guessing unavailable models', () => {
    expect(
      mapAcpSessionModels({
        currentModelId: 'sonnet',
        availableModels: [
          { modelId: 'sonnet', name: 'Claude Sonnet' },
          { modelId: 'opus', name: 'Claude Opus' },
        ],
      })
    ).toEqual([
      { key: 'sonnet', modelId: 'sonnet', label: 'Claude Sonnet', isDefault: true },
      { key: 'opus', modelId: 'opus', label: 'Claude Opus', isDefault: false },
    ]);
    expect(mapAcpSessionModels(undefined)).toEqual([]);
  });

  it('normalizes ACP handshake models and preserves the current model', () => {
    expect(
      parseExperimentalHandshakeModels({
        available_models: [
          { id: 'gpt-5.5/medium', name: 'GPT-5.5 (medium)' },
          { id: 'gpt-5.5/high', label: 'GPT-5.5 (high)' },
        ],
        current_model_id: 'gpt-5.5/medium',
      })
    ).toEqual({
      models: [
        { key: 'gpt-5.5/medium', modelId: 'gpt-5.5/medium', label: 'GPT-5.5 (medium)', isDefault: true },
        { key: 'gpt-5.5/high', modelId: 'gpt-5.5/high', label: 'GPT-5.5 (high)', isDefault: false },
      ],
      defaultModelKey: 'gpt-5.5/medium',
    });
  });

  it('extracts a persisted agent startup error from a terminal tips message', () => {
    expect(
      extractExperimentalTerminalError({
        type: 'tips',
        content: {
          type: 'error',
          content: 'Agent handshake failed',
          error: { detail: 'Agent process exited before initialize handshake completed (exit code 1)' },
        },
      })
    ).toBe('Agent process exited before initialize handshake completed (exit code 1)');
  });
});
