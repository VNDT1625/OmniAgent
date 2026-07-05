/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `PeerWorkspace` — the IDE surface a teammate sees AFTER joining a host's
 * published repo. It is a stripped-down sibling of {@link IdeWorkspace} that
 * never touches the local disk: every read/write rides the team-collab IPC
 * bridge through {@link teamCollabClient.remoteTree}/`.remoteFile`/`.remoteClaim`
 * /`.remoteRelease`/`.remoteWrite`, which forwards to the host's `/team/*` HTTP
 * surface.
 *
 * Three panes:
 *  - Top bar: repo name, host base URL, leave button, busy/error state.
 *  - Left tree: lazily-loaded directory listing (click folder → expand /
 *    `remoteTree`, click file → open in viewer).
 *  - Right viewer: read-only by default. Clicking "Edit" claims a lease,
 *    swaps to a textarea editor, "Save" sends the new content via
 *    `remoteWrite`, and Leave/close releases the lease.
 *
 * This is the "quick-join" mode (everything sourced from host). A future
 * `PeerCloneWorkspace` could mirror files locally so heavy features
 * (LSP, MTUI search) run on the peer's machine without round-tripping.
 *
 * Renderer-only; Arco + @icon-park + UnoCSS tokens; all text via i18n with
 * inline Vietnamese fallbacks (new keys haven't shipped in locales yet).
 */

import { Button, Dropdown, Empty, Input, Menu, Message, Spin, Tooltip } from '@arco-design/web-react';
import {
  CloseSmall,
  Edit,
  FileText,
  FolderOpen,
  Left,
  Lock,
  Logout,
  Plus,
  Refresh,
  Robot,
  Save,
} from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import type { TChatConversation } from '@/common/config/storage';
import ChatConversation from '@/renderer/pages/conversation/components/ChatConversation';
import { useConversationAgents } from '@/renderer/pages/conversation/hooks/useConversationAgents';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { useTranslation } from 'react-i18next';
import { teamCollabClient, type TeamTreeEntry } from './teamCollabClient';
import type { PeerConnection, UseTeamCollab } from './useTeamCollab';
import { useRemoteIdeChat, type RemoteIdeChatLauncher, type RemoteIdeChatTab } from './useRemoteIdeChat';

type PeerWorkspaceProps = {
  /** The active team-collab controller (must be in `peer` role). */
  collab: UseTeamCollab;
  /** Called when the user clicks Back to leave the workspace and go to dashboard. */
  onBack: () => void;
};

type LoadedNode = {
  /** Repo-relative directory path; '' = root. */
  dir: string;
  /** Directory entries from the host. */
  entries: TeamTreeEntry[];
};

/** Join a repo-relative path with the host's POSIX separator. */
const joinRel = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

const PeerWorkspace: React.FC<PeerWorkspaceProps> = ({ collab, onBack }) => {
  const { t } = useTranslation();
  const peer = collab.peer;

  // Cache directory listings by relPath so re-opening a folder is instant.
  const [tree, setTree] = useState<Record<string, LoadedNode>>({});
  // Which directories are expanded (UI only — listing is cached independently).
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [loadingDir, setLoadingDir] = useState<Set<string>>(new Set());
  const [treeError, setTreeError] = useState<string | null>(null);

  // Selected file in the viewer.
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [contentLoading, setContentLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // Edit mode state (lease + dirty + saving).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [claimedPath, setClaimedPath] = useState<string | null>(null);

  /** Fetch one directory's entries from the host and cache them. */
  const loadDir = useCallback(
    async (dir: string): Promise<void> => {
      if (!peer) return;
      setLoadingDir((s) => new Set(s).add(dir));
      const res = await teamCollabClient.remoteTree(peer.baseUrl, peer.token, dir).catch((e): null => {
        setTreeError(e instanceof Error ? e.message : String(e));
        return null;
      });
      setLoadingDir((s) => {
        const next = new Set(s);
        next.delete(dir);
        return next;
      });
      if (!res) return;
      if ('error' in res) {
        setTreeError(res.error);
        return;
      }
      setTreeError(null);
      setTree((prev) => ({ ...prev, [dir]: { dir, entries: res.data } }));
    },
    [peer]
  );

  // Load the root listing as soon as the peer connection is available.
  useEffect(() => {
    if (peer && !tree['']) void loadDir('');
  }, [peer, tree, loadDir]);

  /** Open one file in the viewer (releases any prior lease). */
  const openRemoteFile = useCallback(
    async (relPath: string): Promise<void> => {
      if (!peer) return;
      // Release a prior lease if we held one (best-effort).
      if (claimedPath && claimedPath !== relPath) {
        await teamCollabClient.remoteRelease(peer.baseUrl, peer.token, claimedPath).catch((): undefined => undefined);
        setClaimedPath(null);
      }
      setEditing(false);
      setOpenFile(relPath);
      setContent('');
      setFileError(null);
      setContentLoading(true);
      const res = await teamCollabClient.remoteFile(peer.baseUrl, peer.token, relPath).catch((e): null => {
        setFileError(e instanceof Error ? e.message : String(e));
        return null;
      });
      setContentLoading(false);
      if (!res) return;
      if ('error' in res) {
        setFileError(res.error);
        return;
      }
      setContent(res.data.content);
    },
    [peer, claimedPath]
  );

  /** Switch the viewer to edit mode (claims lease on host). */
  const startEditing = useCallback(async (): Promise<void> => {
    if (!peer || !openFile) return;
    const res = await teamCollabClient.remoteClaim(peer.baseUrl, peer.token, openFile, 'peer-edit').catch((e): null => {
      Message.error(e instanceof Error ? e.message : String(e));
      return null;
    });
    if (!res) return;
    if ('error' in res) {
      Message.error(
        res.error || t('ide.teamCollab.claimFailed', 'Không claim được lease — có thể peer khác đang giữ.')
      );
      return;
    }
    setClaimedPath(openFile);
    setDraft(content);
    setEditing(true);
  }, [peer, openFile, content, t]);

  /** Cancel editing (release lease). */
  const cancelEditing = useCallback(async (): Promise<void> => {
    if (peer && claimedPath) {
      await teamCollabClient.remoteRelease(peer.baseUrl, peer.token, claimedPath).catch((): undefined => undefined);
    }
    setEditing(false);
    setClaimedPath(null);
    setDraft('');
  }, [peer, claimedPath]);

  /** Save draft to host (full-file write under lease, then release). */
  const saveDraft = useCallback(async (): Promise<void> => {
    if (!peer || !openFile) return;
    setSaving(true);
    const res = await teamCollabClient.remoteWrite(peer.baseUrl, peer.token, openFile, draft).catch((e): null => {
      Message.error(e instanceof Error ? e.message : String(e));
      return null;
    });
    setSaving(false);
    if (!res) return;
    if ('error' in res) {
      Message.error(res.error || t('ide.teamCollab.writeFailed', 'Không ghi được file qua host.'));
      return;
    }
    setContent(draft);
    setEditing(false);
    // Release lease so other peers can claim.
    await teamCollabClient.remoteRelease(peer.baseUrl, peer.token, openFile).catch((): undefined => undefined);
    setClaimedPath(null);
    Message.success(t('ide.teamCollab.saved', 'Đã lưu vào máy host.'));
  }, [peer, openFile, draft, t]);

  /** Toggle a directory expand/load. */
  const toggleDir = useCallback(
    (dir: string): void => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dir)) next.delete(dir);
        else next.add(dir);
        return next;
      });
      if (!tree[dir]) void loadDir(dir);
    },
    [tree, loadDir]
  );

  // Locked files from snapshot — show a small lock badge next to claimed files.
  const lockedSet = useMemo<Set<string>>(() => {
    const snap = collab.remoteSnapshot;
    if (!snap) return new Set();
    const out = new Set<string>();
    const leases = (snap as unknown as { leases?: Array<{ relPath?: string }> }).leases ?? [];
    for (const l of leases) if (l.relPath) out.add(l.relPath);
    return out;
  }, [collab.remoteSnapshot]);

  // Cleanup: release lease + leave on unmount (covers tab close / route change).
  useEffect(() => {
    return () => {
      const p = peer;
      const path = claimedPath;
      if (p && path) {
        void teamCollabClient.remoteRelease(p.baseUrl, p.token, path).catch((): undefined => undefined);
      }
    };
  }, [peer, claimedPath]);

  if (!peer) {
    return (
      <div className='size-full flex-center text-t-secondary'>
        {t('ide.teamCollab.noPeerSession', 'Chưa có phiên peer nào đang hoạt động.')}
      </div>
    );
  }

  return (
    <div className='size-full flex flex-col min-h-0 bg-1'>
      {/* Top bar */}
      <PeerHeader peer={peer} collab={collab} onBack={onBack} />

      <div className='flex-1 min-h-0 flex'>
        {/* Tree */}
        <aside className='w-300px shrink-0 border-r border-b-1 flex flex-col min-h-0'>
          <div className='flex items-center justify-between px-12px py-8px border-b border-b-1'>
            <span className='text-12px font-[500] text-t-secondary truncate'>{peer.repoName}</span>
            <Tooltip content={t('common.refresh', 'Làm mới')} mini>
              <Button
                type='text'
                size='mini'
                icon={<Refresh theme='outline' size={13} />}
                onClick={() => {
                  setTree({});
                  setExpanded(new Set(['']));
                  void loadDir('');
                }}
              />
            </Tooltip>
          </div>
          <div className='flex-1 min-h-0 overflow-y-auto p-6px'>
            {treeError ? <div className='text-12px text-danger px-8px py-6px'>{treeError}</div> : null}
            <TreeNode
              dir=''
              tree={tree}
              expanded={expanded}
              loadingDir={loadingDir}
              lockedSet={lockedSet}
              openFile={openFile}
              onToggleDir={toggleDir}
              onOpenFile={(p) => void openRemoteFile(p)}
            />
          </div>
        </aside>

        {/* Viewer */}
        <main className='flex-1 min-w-0 flex flex-col min-h-0'>
          {openFile === null ? (
            <div className='flex-1 flex-center'>
              <Empty
                description={t('ide.teamCollab.pickFile', 'Chọn một tệp ở cây bên trái để xem nội dung từ host.')}
              />
            </div>
          ) : (
            <>
              <div className='shrink-0 flex items-center gap-8px px-16px py-8px border-b border-b-1'>
                <FileText theme='outline' size={14} className='text-t-secondary' />
                <span className='text-13px font-[500] text-t-primary truncate flex-1'>{openFile}</span>
                {editing ? (
                  <>
                    <Button size='mini' onClick={() => void cancelEditing()}>
                      {t('common.cancel', 'Hủy')}
                    </Button>
                    <Button
                      type='primary'
                      size='mini'
                      icon={<Save theme='outline' size={12} />}
                      loading={saving}
                      onClick={() => void saveDraft()}
                    >
                      {t('common.save', 'Lưu')}
                    </Button>
                  </>
                ) : (
                  <Button
                    size='mini'
                    icon={<Edit theme='outline' size={12} />}
                    onClick={() => void startEditing()}
                    disabled={contentLoading || lockedSet.has(openFile)}
                  >
                    {lockedSet.has(openFile)
                      ? t('ide.teamCollab.lockedByPeer', 'Đang bị peer khác giữ')
                      : t('common.edit', 'Sửa')}
                  </Button>
                )}
              </div>
              <div className='flex-1 min-h-0 overflow-auto'>
                {contentLoading ? (
                  <div className='size-full flex-center'>
                    <Spin />
                  </div>
                ) : fileError ? (
                  <div className='p-16px text-danger text-12px'>{fileError}</div>
                ) : editing ? (
                  <Input.TextArea
                    value={draft}
                    onChange={setDraft}
                    autoSize={false}
                    className='!w-full !h-full !rd-0 !border-0 !font-mono !text-12px'
                  />
                ) : (
                  <pre className='m-0 p-16px text-12px text-t-primary font-mono whitespace-pre-wrap break-all'>
                    {content}
                  </pre>
                )}
              </div>
            </>
          )}
        </main>

        <RemotePeerChatPanel peer={peer} />
      </div>
    </div>
  );
};

export const RemotePeerChatPanel: React.FC<{ peer: PeerConnection; fullWidth?: boolean }> = ({ peer, fullWidth }) => {
  const { t, i18n } = useTranslation();
  const chat = useRemoteIdeChat(peer);
  const { cliAgents, presetAssistants, isLoading } = useConversationAgents();
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <aside
      className={`${fullWidth ? 'flex-1 min-w-0' : 'w-420px max-w-42vw shrink-0 border-l'} border-b-1 flex flex-col min-h-0 bg-1`}
    >
      <div className='shrink-0 flex items-center gap-8px px-12px py-8px border-b border-b-1'>
        <Robot theme='outline' size={15} className='text-primary' />
        <div className='min-w-0 flex-1'>
          <div className='text-12px font-[600] text-t-primary truncate'>{t('ide.teamCollab.remoteChatTitle')}</div>
          <div className='text-11px text-t-tertiary truncate'>{t('ide.teamCollab.remoteChatSubtitle')}</div>
        </div>
        <Dropdown
          position='br'
          popupVisible={pickerOpen}
          onVisibleChange={setPickerOpen}
          trigger='click'
          droplist={
            <RemoteAgentMenu
              cliAgents={cliAgents}
              presetAssistants={presetAssistants}
              language={i18n.language}
              loading={isLoading}
              disabled={chat.creating}
              onPick={async (launcher) => {
                setPickerOpen(false);
                await chat.open(launcher);
              }}
            />
          }
        >
          <Tooltip content={t('ide.teamCollab.newAiChat')} mini>
            <Button type='primary' size='mini' loading={chat.creating} icon={<Plus theme='outline' size={12} />} />
          </Tooltip>
        </Dropdown>
      </div>

      {chat.tabs.length > 0 ? (
        <div className='shrink-0 flex items-center gap-4px overflow-x-auto px-8px py-6px border-b border-b-1'>
          {chat.tabs.map((tab) => (
            <div
              key={tab.id}
              className={`flex items-center gap-4px max-w-160px px-8px py-4px rd-6px ${chat.activeId === tab.id ? 'bg-primary-light-1 text-primary' : 'bg-fill-1 text-t-secondary'}`}
            >
              <Button size='mini' type='text' className='!px-0 min-w-0 flex-1' onClick={() => chat.setActive(tab.id)}>
                <span className='truncate text-11px'>{tab.title}</span>
              </Button>
              <Button
                size='mini'
                type='text'
                icon={<CloseSmall theme='outline' size={11} />}
                onClick={() => void chat.close(tab.id)}
              />
            </div>
          ))}
        </div>
      ) : null}

      <div className='flex-1 min-h-0 relative'>
        {chat.tabs.length === 0 ? (
          <div className='size-full flex-center px-16px'>
            <Empty
              description={
                <div className='flex flex-col items-center gap-8px'>
                  <span>{t('ide.teamCollab.remoteChatEmptyTitle')}</span>
                  <Button
                    type='primary'
                    size='small'
                    icon={<Plus theme='outline' size={13} />}
                    onClick={() => setPickerOpen(true)}
                  >
                    {t('ide.teamCollab.newAiChat')}
                  </Button>
                </div>
              }
            />
          </div>
        ) : (
          chat.tabs.map((tab) => (
            <RemoteChatTabBody
              key={tab.id}
              tab={tab}
              active={chat.activeId === tab.id}
              onResolveTitle={(title) => chat.rename(tab.id, title)}
            />
          ))
        )}
      </div>
    </aside>
  );
};

const RemoteChatTabBody: React.FC<{
  tab: RemoteIdeChatTab;
  active: boolean;
  onResolveTitle: (title: string) => void;
}> = ({ tab, active, onResolveTitle }) => {
  const { data, isLoading } = useSWR<TChatConversation | null>(`conversation/${tab.id}`, () =>
    getConversationOrNull(tab.id)
  );

  useEffect(() => {
    if (data?.name && data.name !== tab.title) onResolveTitle(data.name);
  }, [data?.name, onResolveTitle, tab.title]);

  return (
    <div className='absolute inset-0' style={{ display: active ? 'block' : 'none' }} aria-hidden={!active}>
      {isLoading || !data ? (
        <div className='size-full flex-center'>
          <Spin />
        </div>
      ) : (
        <ChatConversation conversation={data} embedded />
      )}
    </div>
  );
};

const RemoteAgentMenu: React.FC<{
  cliAgents: ReturnType<typeof useConversationAgents>['cliAgents'];
  presetAssistants: ReturnType<typeof useConversationAgents>['presetAssistants'];
  language: string;
  loading: boolean;
  disabled: boolean;
  onPick: (launcher: RemoteIdeChatLauncher) => void | Promise<void>;
}> = ({ cliAgents, presetAssistants, language, loading, disabled, onPick }) => {
  const { t } = useTranslation();
  const cliItems = useMemo(() => cliAgents.filter((agent) => agent.available !== false), [cliAgents]);
  const presetItems = useMemo(
    () => presetAssistants.filter((assistant) => assistant.enabled !== false),
    [presetAssistants]
  );
  const menuStyle: React.CSSProperties = { maxHeight: 360, overflowY: 'auto', minWidth: 220, maxWidth: 280 };

  if (loading) {
    return (
      <Menu style={menuStyle}>
        <Menu.Item key='loading' disabled>
          <Spin size={12} /> <span className='ml-6px'>{t('ide.chat.loading')}</span>
        </Menu.Item>
      </Menu>
    );
  }

  if (cliItems.length === 0 && presetItems.length === 0) {
    return (
      <Menu style={menuStyle}>
        <Menu.Item key='noAgents' disabled>
          {t('ide.teamCollab.remoteChatNoAgents')}
        </Menu.Item>
      </Menu>
    );
  }

  return (
    <Menu style={menuStyle}>
      {cliItems.length > 0 ? (
        <Menu.ItemGroup title={t('ide.chat.cliGroup')}>
          {cliItems.map((agent) => (
            <Menu.Item key={`cli:${agent.id}`} disabled={disabled} onClick={() => void onPick({ kind: 'cli', agent })}>
              <span className='block truncate' title={agent.name}>
                {agent.name}
              </span>
            </Menu.Item>
          ))}
        </Menu.ItemGroup>
      ) : null}
      {presetItems.length > 0 ? (
        <Menu.ItemGroup title={t('ide.chat.presetGroup')}>
          {presetItems.map((assistant) => (
            <Menu.Item
              key={`preset:${assistant.id}`}
              disabled={disabled}
              onClick={() => void onPick({ kind: 'preset', assistant, language })}
            >
              <span className='block truncate' title={assistant.name}>
                {assistant.name}
              </span>
            </Menu.Item>
          ))}
        </Menu.ItemGroup>
      ) : null}
    </Menu>
  );
};

/** Top bar for the peer workspace. */
const PeerHeader: React.FC<{ peer: PeerConnection; collab: UseTeamCollab; onBack: () => void }> = ({
  peer,
  collab,
  onBack,
}) => {
  const { t } = useTranslation();
  return (
    <header className='shrink-0 flex items-center gap-12px px-16px py-10px border-b border-b-1 bg-2'>
      <Button type='text' icon={<Left theme='outline' size={16} />} onClick={onBack} />
      <FolderOpen theme='outline' size={16} className='text-primary' />
      <div className='flex flex-col min-w-0'>
        <span className='text-13px font-[600] text-t-primary truncate'>
          {t('ide.teamCollab.joinedRepo', { repo: peer.repoName })}
        </span>
        <code className='text-11px text-t-tertiary font-mono truncate'>{peer.baseUrl}</code>
      </div>
      <span className='flex-1' />
      <Button
        size='mini'
        status='danger'
        icon={<Logout theme='outline' size={12} />}
        onClick={() => {
          void collab.leave();
        }}
      >
        {t('ide.teamCollab.leave')}
      </Button>
    </header>
  );
};

type TreeNodeProps = {
  dir: string;
  tree: Record<string, LoadedNode>;
  expanded: Set<string>;
  loadingDir: Set<string>;
  lockedSet: Set<string>;
  openFile: string | null;
  onToggleDir: (dir: string) => void;
  onOpenFile: (relPath: string) => void;
};

/** Recursive directory row. Files render as a single row; dirs as a header + (when expanded) children. */
const TreeNode: React.FC<TreeNodeProps> = ({
  dir,
  tree,
  expanded,
  loadingDir,
  lockedSet,
  openFile,
  onToggleDir,
  onOpenFile,
}) => {
  const node = tree[dir];
  if (!node) {
    return loadingDir.has(dir) ? <div className='px-8px py-4px text-11px text-t-tertiary'>…</div> : null;
  }
  return (
    <div>
      {node.entries.map((e) => {
        const rel = joinRel(dir, e.name);
        if (e.isDir) {
          const isOpen = expanded.has(rel);
          return (
            <div key={rel}>
              <Button
                type='text'
                size='mini'
                onClick={() => onToggleDir(rel)}
                className='!w-full !justify-start !px-6px !py-2px'
              >
                <span className='text-11px text-t-tertiary w-12px'>{isOpen ? '▾' : '▸'}</span>
                <FolderOpen theme='outline' size={12} className='text-warning' />
                <span className='text-12px text-t-primary truncate'>{e.name}</span>
              </Button>
              {isOpen ? (
                <div className='pl-14px'>
                  <TreeNode
                    dir={rel}
                    tree={tree}
                    expanded={expanded}
                    loadingDir={loadingDir}
                    lockedSet={lockedSet}
                    openFile={openFile}
                    onToggleDir={onToggleDir}
                    onOpenFile={onOpenFile}
                  />
                </div>
              ) : null}
            </div>
          );
        }
        const isOpen = openFile === rel;
        const isLocked = lockedSet.has(rel);
        return (
          <Button
            key={rel}
            type='text'
            size='mini'
            onClick={() => onOpenFile(rel)}
            className={`!w-full !justify-start !px-6px !py-2px ${isOpen ? '!bg-primary-light-1' : ''}`}
          >
            <span className='w-12px' />
            <FileText theme='outline' size={12} className='text-t-tertiary' />
            <span className='text-12px text-t-primary truncate flex-1 text-left'>{e.name}</span>
            {isLocked ? <Lock theme='outline' size={11} className='text-warning shrink-0' /> : null}
          </Button>
        );
      })}
    </div>
  );
};

export default PeerWorkspace;
