import type { TChatConversation } from '@/common/config/storage';
import {
  isConversationForIdeWorkspace,
  resolveIdeChatActiveIdAfterClose,
  resolveRestoredIdeChatActiveId,
  type IdeChatTab,
} from '@/renderer/pages/studio/ide/useIdeChat';
import { describe, expect, it } from 'vitest';

const conversation = (workspace: string, extra: Record<string, unknown> = {}): TChatConversation =>
  ({ id: workspace, extra: { workspace, ...extra } }) as unknown as TChatConversation;

const tabs: IdeChatTab[] = [
  { id: 'a', title: 'A', memId: 'memory-a' },
  { id: 'b', title: 'B', memId: 'memory-b' },
  { id: 'c', title: 'C', memId: 'memory-c' },
];

describe('IDE chat workspace history discovery', () => {
  const rootPath = String.raw`C:\NDT\PJ\Ai_Security-main`;

  it('restores regular, legacy IDE and Telegram conversations from equivalent workspace paths', () => {
    expect(isConversationForIdeWorkspace(conversation('C:/NDT/PJ/Ai_Security-main/'), rootPath)).toBe(true);
    expect(
      isConversationForIdeWorkspace(
        conversation(String.raw`\\?\C:\NDT\PJ\Ai_Security-main`, { surface: 'ide' }),
        rootPath
      )
    ).toBe(true);
    expect(
      isConversationForIdeWorkspace(
        conversation(rootPath, { mcp_servers: ['aionui-ide'], surface: undefined }),
        rootPath
      )
    ).toBe(true);
  });

  it('does not restore conversations from another workspace or owned by team and cron surfaces', () => {
    expect(isConversationForIdeWorkspace(conversation(String.raw`C:\NDT\PJ\Other`), rootPath)).toBe(false);
    expect(isConversationForIdeWorkspace(conversation(rootPath, { team_id: 'team-1' }), rootPath)).toBe(false);
    expect(isConversationForIdeWorkspace(conversation(rootPath, { cron_job_id: 'cron-1' }), rootPath)).toBe(false);
  });
});

describe('IDE chat active tab selection', () => {
  it('preserves the selected tab during a background refresh', () => {
    expect(resolveRestoredIdeChatActiveId(tabs, 'b')).toBe('b');
  });

  it('falls back to the first restored tab when the selected tab no longer exists', () => {
    expect(resolveRestoredIdeChatActiveId(tabs, 'missing')).toBe('a');
  });

  it('selects the closest remaining tab when closing the active tab', () => {
    expect(resolveIdeChatActiveIdAfterClose(tabs, 'c')).toBe('b');
    expect(resolveIdeChatActiveIdAfterClose(tabs, 'b')).toBe('c');
    expect(resolveIdeChatActiveIdAfterClose([{ id: 'a', title: 'A', memId: 'memory-a' }], 'a')).toBeNull();
  });
});
