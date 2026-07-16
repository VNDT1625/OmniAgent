import type { TChatConversation } from '@/common/config/storage';
import { groupConversationsByWorkspace } from '@/renderer/pages/conversation/GroupedHistory/utils/groupingHelpers';
import { describe, expect, it } from 'vitest';

const conversation = (id: string, workspace: string, modifiedAt: number): TChatConversation =>
  ({
    id,
    modified_at: modifiedAt,
    created_at: modifiedAt,
    extra: { workspace, custom_workspace: true },
  }) as unknown as TChatConversation;

describe('workspace conversation grouping', () => {
  it('groups Windows slash and verbatim paths under one project folder', () => {
    const sections = groupConversationsByWorkspace(
      [
        conversation('telegram-ide', String.raw`\\?\C:\NDT\PJ\Ai_Security-main`, 2),
        conversation('desktop-ide', String.raw`C:\NDT\PJ\Ai_Security-main`, 1),
        conversation('slash-ide', 'C:/NDT/PJ/Ai_Security-main/', 0),
      ],
      (key) => key
    );
    const workspaceItems = sections[0].items.filter((item) => item.type === 'workspace');

    expect(workspaceItems).toHaveLength(1);
    expect(workspaceItems[0].workspaceGroup?.workspace).toBe(String.raw`C:\NDT\PJ\Ai_Security-main`);
    expect(workspaceItems[0].workspaceGroup?.conversations.map((item) => item.id)).toEqual([
      'telegram-ide',
      'desktop-ide',
      'slash-ide',
    ]);
  });
});
