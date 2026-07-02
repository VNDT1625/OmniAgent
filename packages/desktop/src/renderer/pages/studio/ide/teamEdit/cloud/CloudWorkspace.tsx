/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Cloud-authoritative IDE workspace surface: tree, editor, realtime status, AI chat. */

import { Button, Empty, Input, Message, Spin, Tag, Tooltip } from '@arco-design/web-react';
import { Cloudy, Edit, FileText, FolderOpen, Left, Refresh, Save } from '@icon-park/react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TeamTreeEntry } from '@process/ide/teamEdit/teamSessionHost';
import { cloudWorkspaceClient } from './cloudWorkspaceClient';
import type { CloudWorkspaceConnection, UseCloudWorkspace } from './useCloudWorkspace';
import { RemotePeerChatPanel } from '../PeerWorkspace';

type CloudWorkspaceProps = {
  cloud: UseCloudWorkspace;
  onBack: () => void;
};

type LoadedNode = { dir: string; entries: TeamTreeEntry[] };

const joinRel = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

const CloudWorkspace: React.FC<CloudWorkspaceProps> = ({ cloud, onBack }) => {
  const { t } = useTranslation();
  const session = cloud.session;
  const [tree, setTree] = useState<Record<string, LoadedNode>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [loadingDir, setLoadingDir] = useState<Set<string>>(new Set());
  const [treeError, setTreeError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const loadDir = useCallback(
    async (dir: string): Promise<void> => {
      if (!session) return;
      setLoadingDir((prev) => new Set(prev).add(dir));
      const res = await cloudWorkspaceClient.tree(session.workspaceId, dir).catch((error): null => {
        setTreeError(error instanceof Error ? error.message : String(error));
        return null;
      });
      setLoadingDir((prev) => {
        const next = new Set(prev);
        next.delete(dir);
        return next;
      });
      if (!res) return;
      if (res.ok === false) {
        setTreeError(res.error);
        return;
      }
      setTreeError(null);
      setTree((prev) => ({ ...prev, [dir]: { dir, entries: res.data } }));
      await cloud.refreshStatus();
    },
    [cloud, session]
  );

  useEffect(() => {
    if (session && !tree['']) void loadDir('');
  }, [loadDir, session, tree]);

  const openCloudFile = useCallback(
    async (relPath: string): Promise<void> => {
      if (!session) return;
      setOpenFile(relPath);
      setEditing(false);
      setContent('');
      setDraft('');
      setFileError(null);
      setContentLoading(true);
      const res = await cloudWorkspaceClient.file(session.workspaceId, relPath).catch((error): null => {
        setFileError(error instanceof Error ? error.message : String(error));
        return null;
      });
      setContentLoading(false);
      if (!res) return;
      if (res.ok === false) {
        setFileError(res.error);
        return;
      }
      setContent(res.data.content);
      setDraft(res.data.content);
      await cloud.refreshStatus();
    },
    [cloud, session]
  );

  const saveDraft = useCallback(async (): Promise<void> => {
    if (!session || !openFile) return;
    setSaving(true);
    const res = await cloudWorkspaceClient.write(session.workspaceId, openFile, draft).catch((error): null => {
      Message.error(error instanceof Error ? error.message : String(error));
      return null;
    });
    setSaving(false);
    if (!res) return;
    if (res.ok === false) {
      Message.error(res.error);
      return;
    }
    setContent(draft);
    setEditing(false);
    await cloud.refreshStatus();
    Message.success(t('ide.cloudWorkspace.saved'));
  }, [cloud, draft, openFile, session, t]);

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
    [loadDir, tree]
  );

  if (!session) {
    return <div className='size-full flex-center text-t-secondary'>{t('ide.cloudWorkspace.noSession')}</div>;
  }

  return (
    <div className='size-full flex flex-col min-h-0 bg-1'>
      <CloudHeader session={session} cloud={cloud} onBack={onBack} />
      <div className='flex-1 min-h-0 flex'>
        <aside className='w-300px shrink-0 border-r border-b-1 flex flex-col min-h-0'>
          <div className='flex items-center justify-between px-12px py-8px border-b border-b-1'>
            <span className='text-12px font-[500] text-t-secondary truncate'>{session.workspaceId}</span>
            <Tooltip content={t('common.refresh')} mini>
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
              openFile={openFile}
              onToggleDir={toggleDir}
              onOpenFile={(path) => void openCloudFile(path)}
            />
          </div>
        </aside>

        <main className='flex-1 min-w-0 flex flex-col min-h-0'>
          {openFile === null ? (
            <div className='flex-1 flex-center'>
              <Empty description={t('ide.cloudWorkspace.pickFile')} />
            </div>
          ) : (
            <>
              <div className='shrink-0 flex items-center gap-8px px-16px py-8px border-b border-b-1'>
                <FileText theme='outline' size={14} className='text-t-secondary' />
                <span className='text-13px font-[500] text-t-primary truncate flex-1'>{openFile}</span>
                {editing ? (
                  <>
                    <Button size='mini' onClick={() => setEditing(false)}>
                      {t('common.cancel')}
                    </Button>
                    <Button
                      type='primary'
                      size='mini'
                      icon={<Save theme='outline' size={12} />}
                      loading={saving}
                      onClick={() => void saveDraft()}
                    >
                      {t('common.save')}
                    </Button>
                  </>
                ) : (
                  <Button
                    size='mini'
                    icon={<Edit theme='outline' size={12} />}
                    disabled={contentLoading}
                    onClick={() => {
                      setDraft(content);
                      setEditing(true);
                    }}
                  >
                    {t('common.edit')}
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

        <RemotePeerChatPanel peer={session} />
      </div>
    </div>
  );
};

const CloudHeader: React.FC<{
  session: CloudWorkspaceConnection;
  cloud: UseCloudWorkspace;
  onBack: () => void;
}> = ({ session, cloud, onBack }) => {
  const { t } = useTranslation();
  const participantCount = cloud.state?.participants.length ?? 0;
  return (
    <header className='shrink-0 flex items-center gap-12px px-16px py-10px border-b border-b-1 bg-2'>
      <Button type='text' icon={<Left theme='outline' size={16} />} onClick={onBack} />
      <Cloudy theme='outline' size={16} className='text-primary' />
      <div className='flex flex-col min-w-0'>
        <span className='text-13px font-[600] text-t-primary truncate'>
          {t('ide.cloudWorkspace.connectedTitle', { workspace: session.workspaceId })}
        </span>
        <code className='text-11px text-t-tertiary font-mono truncate'>{session.relayBaseUrl}</code>
      </div>
      <Tag size='small' color={cloud.state?.state === 'connected' ? 'green' : 'orange'}>
        {cloud.state?.state ?? 'idle'}
      </Tag>
      <Tag size='small'>{t('ide.cloudWorkspace.seqLabel', { seq: cloud.manifest?.seq ?? 0 })}</Tag>
      <Tag size='small'>{t('ide.cloudWorkspace.participantsLabel', { count: participantCount })}</Tag>
      <span className='flex-1' />
      <Button size='mini' status='danger' onClick={() => void cloud.disconnect()}>
        {t('ide.cloudWorkspace.disconnect')}
      </Button>
    </header>
  );
};

type TreeNodeProps = {
  dir: string;
  tree: Record<string, LoadedNode>;
  expanded: Set<string>;
  loadingDir: Set<string>;
  openFile: string | null;
  onToggleDir: (dir: string) => void;
  onOpenFile: (relPath: string) => void;
};

const TreeNode: React.FC<TreeNodeProps> = ({ dir, tree, expanded, loadingDir, openFile, onToggleDir, onOpenFile }) => {
  const node = tree[dir];
  if (!node) {
    return loadingDir.has(dir) ? <div className='px-8px py-4px text-11px text-t-tertiary'>...</div> : null;
  }
  return (
    <div>
      {node.entries.map((entry) => {
        const rel = joinRel(dir, entry.name);
        if (entry.isDir) {
          const isOpen = expanded.has(rel);
          return (
            <div key={rel}>
              <Button
                type='text'
                size='mini'
                className='!w-full !justify-start !px-6px !py-2px'
                onClick={() => onToggleDir(rel)}
              >
                <span className='text-11px text-t-tertiary w-12px'>{isOpen ? 'v' : '>'}</span>
                <FolderOpen theme='outline' size={12} className='text-warning' />
                <span className='text-12px text-t-primary truncate'>{entry.name}</span>
              </Button>
              {isOpen ? (
                <div className='pl-14px'>
                  <TreeNode
                    dir={rel}
                    tree={tree}
                    expanded={expanded}
                    loadingDir={loadingDir}
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
        return (
          <Button
            key={rel}
            type='text'
            size='mini'
            className={`!w-full !justify-start !px-6px !py-2px ${isOpen ? '!bg-primary-light-1' : ''}`}
            onClick={() => onOpenFile(rel)}
          >
            <span className='w-12px' />
            <FileText theme='outline' size={12} className='text-t-tertiary' />
            <span className='text-12px text-t-primary truncate flex-1 text-left'>{entry.name}</span>
          </Button>
        );
      })}
    </div>
  );
};

export default CloudWorkspace;
