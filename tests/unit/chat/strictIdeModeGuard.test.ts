/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IMessageAcpPermission } from '@/common/chat/chatLib';
import {
  enforceStrictIdeModeOnConfirmation,
  enforceStrictIdeModeOnPermission,
  enforceStrictIdeSessionMode,
  isStrictIdeModeEnabled,
  setStrictIdeModeEnabled,
} from '@/renderer/pages/conversation/platforms/strictIdeModeGuard';

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      confirmMessage: { invoke: vi.fn() },
      stop: { invoke: vi.fn() },
    },
  },
}));

vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: vi.fn(),
}));

vi.mock('@/renderer/pages/studio/ide/ideClient', () => ({
  ideClient: {},
}));

vi.mock('@/renderer/pages/studio/ide/teamEdit/teamEditClient', () => ({
  teamEditClient: {},
}));

const permissionOptions = [
  { option_id: 'allow', name: 'Allow', kind: 'allow_once' as const },
  { option_id: 'reject', name: 'Reject', kind: 'reject_once' as const },
];

const message = (toolCall: IMessageAcpPermission['content']['tool_call']): IMessageAcpPermission =>
  ({
    id: 'msg-1',
    conversation_id: 'conv-1',
    content: {
      tool_call: toolCall,
      options: permissionOptions,
    },
  }) as IMessageAcpPermission;

const installStorage = (): void => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
    removeItem: (key: string): void => {
      values.delete(key);
    },
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Strict IDE Mode toggle and permission modes', () => {
  it('returns native tools to normal default approval after Strict Mode is disabled', async () => {
    installStorage();
    setStrictIdeModeEnabled('C:/repo', true);
    expect(isStrictIdeModeEnabled('C:/repo')).toBe(true);

    setStrictIdeModeEnabled('C:/repo', false);
    expect(isStrictIdeModeEnabled('C:/repo')).toBe(false);

    const confirm = vi.fn();
    const result = await enforceStrictIdeModeOnPermission(
      message({ title: 'Bash', tool_call_id: 'call-1', raw_input: { command: 'dir' } }),
      { resolveWorkspacePath: async () => 'C:/repo', confirm }
    );

    expect(result).toEqual({ denied: false, reason: 'strict-mode-off' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('lets YOLO auto-approve native tools when Strict Mode is off', async () => {
    const confirm = vi.fn(async (): Promise<void> => undefined);

    const result = await enforceStrictIdeModeOnPermission(
      message({ title: 'Bash', tool_call_id: 'call-1', raw_input: { command: 'dir' } }),
      {
        isEnabled: () => false,
        resolveWorkspacePath: async () => 'C:/repo',
        permissionMode: 'auto',
        confirm,
      }
    );

    expect(result.denied).toBe(true);
    expect(confirm).toHaveBeenCalledWith({
      confirm_key: 'allow',
      msg_id: 'msg-1',
      conversation_id: 'conv-1',
      call_id: 'call-1',
    });
  });
  it('keeps YOLO active for allowed IDE tools while Strict Mode blocks native tools', async () => {
    const confirm = vi.fn(async (): Promise<void> => undefined);

    const result = await enforceStrictIdeModeOnPermission(
      message({ title: 'ide_search', tool_call_id: 'call-1', raw_input: { query: 'needle' } }),
      {
        isEnabled: () => true,
        resolveWorkspacePath: async () => 'C:/repo',
        permissionMode: 'auto',
        confirm,
      }
    );

    expect(result.denied).toBe(true);
    expect(confirm).toHaveBeenCalledWith({
      confirm_key: 'allow',
      msg_id: 'msg-1',
      conversation_id: 'conv-1',
      call_id: 'call-1',
    });
  });
});

describe('enforceStrictIdeModeOnPermission', () => {
  it('auto-denies a native tool and returns the mandatory remap reason', async () => {
    const confirm = vi.fn(
      async (_params: {
        confirm_key: string;
        msg_id: string;
        conversation_id: string;
        call_id: string;
      }): Promise<void> => undefined
    );

    const result = await enforceStrictIdeModeOnPermission(
      message({ title: 'Grep', tool_call_id: 'call-1', raw_input: { pattern: 'needle' } }),
      {
        isEnabled: () => true,
        resolveWorkspacePath: async () => 'C:/repo',
        confirm,
      }
    );

    expect(result.denied).toBe(true);
    expect(result.reason).toContain('Strict IDE Mode');
    expect(result.reason).toContain('ide_search');
    expect(result.reason).toContain('Hãy dùng');
    expect(result.reason).toContain('không được chạy');
    // Simple auto-deny: we do call confirm with the reject option
    expect(confirm).toHaveBeenCalled();
  });

  it('stops the turn when a denied ACP call has no reject option', async () => {
    const stop = vi.fn(async (): Promise<void> => undefined);
    const result = await enforceStrictIdeModeOnPermission(
      {
        id: 'msg-1',
        conversation_id: 'conv-1',
        content: {
          tool_call: { title: 'Bash', raw_input: { command: 'echo hi' } },
          options: [{ option_id: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      } as IMessageAcpPermission,
      {
        isEnabled: () => true,
        resolveWorkspacePath: async () => 'C:/repo',
        stop,
      }
    );

    expect(result.denied).toBe(true);
    expect(result.reason).toContain('Strict IDE Mode');
    expect(stop).toHaveBeenCalledWith({ conversation_id: 'conv-1' });
  });

  it('stops the turn when rejecting an ACP call fails', async () => {
    const stop = vi.fn(async (): Promise<void> => undefined);
    const result = await enforceStrictIdeModeOnPermission(
      message({ title: 'Bash', tool_call_id: 'call-1', raw_input: { command: 'echo hi' } }),
      {
        isEnabled: () => true,
        resolveWorkspacePath: async () => 'C:/repo',
        confirm: async () => Promise.reject(new Error('confirm failed')),
        stop,
      }
    );

    expect(result.denied).toBe(true);
    expect(stop).toHaveBeenCalledWith({ conversation_id: 'conv-1' });
  });

  it('stops the turn when a denied confirmation has no reject key', async () => {
    const stop = vi.fn(async (): Promise<void> => undefined);
    const result = await enforceStrictIdeModeOnConfirmation(
      {
        id: 'msg-2',
        conversation_id: 'conv-2',
        content: {
          call_id: 'call-2',
          action: 'Bash',
          command_type: 'shell',
          options: [{ label: 'Allow', value: 'allow' }],
        },
      },
      {
        isEnabled: () => true,
        resolveWorkspacePath: async () => 'C:/repo',
        stop,
      }
    );

    expect(result.denied).toBe(true);
    expect(result.reason).toContain('Strict IDE Mode');
    expect(stop).toHaveBeenCalledWith({ conversation_id: 'conv-2' });
  });

  it('stops the turn when rejecting a confirmation fails', async () => {
    const stop = vi.fn(async (): Promise<void> => undefined);
    const result = await enforceStrictIdeModeOnConfirmation(
      {
        id: 'msg-2',
        conversation_id: 'conv-2',
        content: {
          call_id: 'call-2',
          action: 'Bash',
          command_type: 'shell',
          options: [{ label: 'Reject', value: 'reject' }],
        },
      },
      {
        isEnabled: () => true,
        resolveWorkspacePath: async () => 'C:/repo',
        confirm: async () => Promise.reject(new Error('confirm failed')),
        stop,
      }
    );

    expect(result.denied).toBe(true);
    expect(stop).toHaveBeenCalledWith({ conversation_id: 'conv-2' });
  });
});

describe('enforceStrictIdeSessionMode', () => {
  it('persists and applies the restrictive mode for an existing Claude session', async () => {
    const persistMode = vi.fn(async (): Promise<boolean> => true);
    const setMode = vi.fn(async (): Promise<boolean> => true);

    const result = await enforceStrictIdeSessionMode('conv-1', {
      loadConversation: async () => ({ type: 'acp', extra: { backend: 'claude' } }),
      persistMode,
      setMode,
    });

    expect(result).toBe(true);
    expect(persistMode).toHaveBeenCalledWith('conv-1', 'default');
    expect(setMode).toHaveBeenCalledWith('conv-1', 'default');
  });
});
