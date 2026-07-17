import type { TChatConversation } from '@/common/config/storage';
import {
  isConversationForIdeWorkspace,
  mergeIdeSessionMcpServers,
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

describe('IDE chat MCP attachment', () => {
  const ideServer = {
    id: 'ide-live',
    name: 'aionui-ide',
    transport: { type: 'sse', url: 'http://127.0.0.1:4100/sse' },
  } as const;
  const browserServer = {
    id: 'browser-live',
    name: 'aionui-browser-control',
    transport: { type: 'sse', url: 'http://127.0.0.1:4200/sse' },
  } as const;

  it('refreshes Browser-Control to the live endpoint when Super is already enabled', () => {
    const merged = mergeIdeSessionMcpServers(
      [
        {
          id: 'browser-stale',
          name: 'aionui-browser-control',
          transport: { type: 'sse', url: 'http://127.0.0.1:9999/sse' },
        },
        { id: 'custom', name: 'custom-tools', transport: { type: 'sse', url: 'https://example.test/sse' } },
      ],
      ideServer,
      null,
      browserServer
    );

    expect(merged.find((server) => server.name === 'aionui-browser-control')).toEqual(browserServer);
    expect(merged.some((server) => server.name === 'custom-tools')).toBe(true);
  });

  it('attaches Browser-Control when an IDE conversation did not previously have it', () => {
    const merged = mergeIdeSessionMcpServers(
      [{ id: 'custom', name: 'custom-tools', transport: { type: 'sse', url: 'https://example.test/sse' } }],
      ideServer,
      null,
      browserServer
    );

    expect(merged.some((server) => server.name === 'aionui-browser-control')).toBe(true);
    expect(merged.some((server) => server.name === 'custom-tools')).toBe(true);
  });

  it('keeps the IDE usable when Browser-Control is temporarily absent from the catalog', () => {
    const merged = mergeIdeSessionMcpServers([], ideServer, null, undefined);

    expect(merged.some((server) => server.name === 'aionui-browser-control')).toBe(false);
    expect(merged.some((server) => server.name === 'aionui-ide')).toBe(true);
  });
});
