/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { IMessageAcpPermission } from '@/common/chat/chatLib';
import {
  enforceStrictIdeModeOnConfirmation,
  enforceStrictIdeModeOnPermission,
  enforceStrictIdeSessionMode,
} from '@/renderer/pages/conversation/platforms/strictIdeModeGuard';

vi.mock('@/common', () => ({
  ipcBridge: { conversation: { confirmMessage: { invoke: vi.fn() } } },
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
    // Simple auto-deny: we do call confirm with the reject option
    expect(confirm).toHaveBeenCalled();
  });

  it('does NOT stop the turn when the backend provides no reject option (shows the card instead)', async () => {
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
      }
    );

    expect(result).toEqual({ denied: false, reason: 'no-reject-option' });
  });

  it('does NOT stop the turn for confirmation protocols without a reject key', async () => {
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
      }
    );

    expect(result).toEqual({ denied: false, reason: 'no-reject-option' });
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
