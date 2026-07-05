/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Cloud-authoritative IDE workspace surface: tree, editor, realtime status, AI chat. */

import { Button, Empty, Input, Message, Spin, Tag, Tooltip } from '@arco-design/web-react';
import {
  Close,
  Cloudy,
  Download,
  Edit,
  FileText,
  FolderOpen,
  Left,
  MessageOne,
  Refresh,
  Save,
  Upload,
} from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TeamTreeEntry } from '@process/ide/teamEdit/teamSessionHost';
import { cloudWorkspaceClient } from './cloudWorkspaceClient';
import type { CloudWorkspaceConnection, UseCloudWorkspace } from './useCloudWorkspace';
import { RemotePeerChatPanel } from '../PeerWorkspace';

type CloudWorkspaceProps = {
  cloud: UseCloudWorkspace;
  onBack: () => void;
  sourceRootPath?: string | null;
  onPickLocalFolder?: () => void;
};

type LoadedNode = { dir: string; entries: TeamTreeEntry[] };
type CloudMode = 'files' | 'chat';

const joinRel = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

const CloudWorkspace: React.FC<CloudWorkspaceProps> = ({ cloud, onBack, sourceRootPath, onPickLocalFolder }) => {
  const { t } = useTranslation();
  const session = cloud.session;
  const [mode, setMode] = useState<CloudMode>('files');
  const [tree, setTree] = useState<Record<string, LoadedNode>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [loadingDir, setLoadingDir] = useState<Set<string>>(new Set());
  const [treeError, setTreeError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const handledPublishFinishRef = useRef<number | undefined>(undefined);
  const handledPullFinishRef = useRef<number | undefined>(undefined);
  const lastSeqRef = useRef<number | undefined>(undefined);
  const progress = cloud.publishProgress;
  const pullProgress = cloud.pullProgress;
  const manifestFileCount = useMemo(
    () => Object.values(cloud.manifest?.files ?? {}).filter((file) => !file.deleted).length,
    [cloud.manifest]
  );

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

  const reloadTree = useCallback((): void => {
    setTree({});
    setExpanded(new Set(['']));
    void loadDir('');
  }, [loadDir]);

  useEffect(() => {
    if (session && !tree['']) void loadDir('');
  }, [loadDir, session, tree]);

  const openCloudFile = useCallback(
    async (relPath: string): Promise<void> => {
      if (!session) return;
      setOpenFile(relPath);
      setOpenFiles((prev) => (prev.includes(relPath) ? prev : [...prev, relPath]));
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

  const closeCloudFile = useCallback(
    (relPath: string): void => {
      setOpenFiles((prev) => prev.filter((path) => path !== relPath));
      setOpenFile((current) => {
        if (current !== relPath) return current;
        const remaining = openFiles.filter((path) => path !== relPath);
        return remaining[remaining.length - 1] ?? null;
      });
      if (openFile === relPath) {
        setContent('');
        setDraft('');
        setEditing(false);
        if (editing) void cloud.releaseFile(relPath);
      }
    },
    [cloud, editing, openFile, openFiles]
  );

  const publishLocal = useCallback(async (): Promise<void> => {
    if (!sourceRootPath) {
      onPickLocalFolder?.();
      return;
    }
    const ok = await cloud.publishLocal(sourceRootPath);
    if (!ok && cloud.error) Message.error(cloud.error);
  }, [cloud, onPickLocalFolder, sourceRootPath]);

  const pullCloud = useCallback(async (): Promise<void> => {
    if (!sourceRootPath) {
      onPickLocalFolder?.();
      return;
    }
    const ok = await cloud.pullCloud(sourceRootPath);
    if (!ok && cloud.error) Message.error(cloud.error);
  }, [cloud, onPickLocalFolder, sourceRootPath]);

  useEffect(() => {
    if (!progress?.done || !progress.finishedAt || handledPublishFinishRef.current === progress.finishedAt) return;
    handledPublishFinishRef.current = progress.finishedAt;
    reloadTree();
    if (progress.failed > 0) {
      Message.warning(t('ide.cloudWorkspace.publishPartial', { failed: progress.failed }));
    } else {
      Message.success(t('ide.cloudWorkspace.publishSuccess'));
    }
  }, [progress?.done, progress?.failed, progress?.finishedAt, reloadTree, t]);

  useEffect(() => {
    if (!pullProgress?.done || !pullProgress.finishedAt || handledPullFinishRef.current === pullProgress.finishedAt)
      return;
    handledPullFinishRef.current = pullProgress.finishedAt;
    if (pullProgress.failed > 0) {
      Message.warning(t('ide.cloudWorkspace.pullPartial', { failed: pullProgress.failed }));
    } else {
      Message.success(t('ide.cloudWorkspace.pullSuccess'));
    }
  }, [pullProgress?.done, pullProgress?.failed, pullProgress?.finishedAt, t]);

  useEffect(() => {
    const seq = cloud.manifest?.seq;
    if (!session || seq === undefined || lastSeqRef.current === seq) return;
    const previous = lastSeqRef.current;
    lastSeqRef.current = seq;
    if (previous === undefined) return;
    reloadTree();
    if (openFile && !editing) void openCloudFile(openFile);
  }, [cloud.manifest?.seq, editing, openCloudFile, openFile, reloadTree, session]);

  const beginEdit = useCallback(async (): Promise<void> => {
    if (!openFile) return;
    const ok = await cloud.claimFile(openFile, 'edit');
    if (!ok) {
      Message.error(cloud.error || t('ide.cloudWorkspace.claimFailed'));
      return;
    }
    setDraft(content);
    setEditing(true);
  }, [cloud, content, openFile, t]);

  const cancelEdit = useCallback((): void => {
    const file = openFile;
    setDraft(content);
    setEditing(false);
    if (file) void cloud.releaseFile(file);
  }, [cloud, content, openFile]);

  const saveDraft = useCallback(async (): Promise<void> => {
    if (!session || !openFile) return;
    setSaving(true);
    const res =
      content.length > 0
        ? await cloudWorkspaceClient.edit(session.workspaceId, openFile, content, draft).catch((error): null => {
            Message.error(error instanceof Error ? error.message : String(error));
            return null;
          })
        : await cloudWorkspaceClient.write(session.workspaceId, openFile, draft).catch((error): null => {
            Message.error(error instanceof Error ? error.message : String(error));
            return null;
          });
    setSaving(false);
    if (!res) return;
    if (res.ok === false) {
      Message.error(res.error);
      return;
    }
    await cloud.releaseFile(openFile);
    setContent(draft);
    setEditing(false);
    await cloud.refreshStatus();
    Message.success(t('ide.cloudWorkspace.saved'));
  }, [cloud, content, draft, openFile, session, t]);

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
      <CloudHeader
        session={session}
        cloud={cloud}
        fileCount={manifestFileCount}
        sourceRootPath={sourceRootPath}
        progress={progress}
        pullProgress={pullProgress}
        onBack={onBack}
        onPublish={() => void publishLocal()}
        onPull={() => void pullCloud()}
      />
      <div className='flex-1 min-h-0 flex'>
        <nav className='w-60px shrink-0 flex flex-col items-center gap-6px py-12px border-r border-b-1'>
          <CloudActivityItem
            active={mode === 'files'}
            icon={<FileText theme='outline' size={19} />}
            label={t('ide.mode.files')}
            onClick={() => setMode('files')}
          />
          <CloudActivityItem
            active={mode === 'chat'}
            icon={<MessageOne theme='outline' size={19} />}
            label={t('ide.mode.chat')}
            onClick={() => setMode('chat')}
          />
        </nav>

        {mode === 'files' ? (
          <>
            <aside className='w-260px shrink-0 border-r border-b-1 flex flex-col min-h-0'>
              <div className='flex items-center justify-between px-12px py-8px border-b border-b-1'>
                <span className='text-12px font-[500] text-t-secondary truncate'>{session.workspaceId}</span>
                <Tooltip content={t('common.refresh')} mini>
                  <Button type='text' size='mini' icon={<Refresh theme='outline' size={13} />} onClick={reloadTree} />
                </Tooltip>
              </div>
              <div className='flex-1 min-h-0 overflow-y-auto p-6px'>
                {treeError ? <div className='text-12px text-danger px-8px py-6px'>{treeError}</div> : null}
                {manifestFileCount === 0 ? (
                  <CloudEmptyState
                    canPublish={Boolean(sourceRootPath)}
                    publishing={cloud.publishing}
                    progress={progress}
                    error={cloud.error}
                    onPublish={() => void publishLocal()}
                    onPickLocalFolder={onPickLocalFolder}
                  />
                ) : (
                  <TreeNode
                    dir=''
                    tree={tree}
                    expanded={expanded}
                    loadingDir={loadingDir}
                    openFile={openFile}
                    onToggleDir={toggleDir}
                    onOpenFile={(path) => void openCloudFile(path)}
                  />
                )}
              </div>
            </aside>

            <main className='flex-1 min-w-0 flex flex-col min-h-0'>
              {openFiles.length > 0 ? (
                <CloudEditorTabs
                  openFiles={openFiles}
                  activeFile={openFile}
                  onSelect={(path) => void openCloudFile(path)}
                  onClose={closeCloudFile}
                />
              ) : null}
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
                        <Button size='mini' onClick={cancelEdit}>
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
                        onClick={() => void beginEdit()}
                      >
                        {t('common.edit')}
                      </Button>
                    )}
                  </div>
                  <div className='flex-1 min-h-0 overflow-auto bg-1'>
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
          </>
        ) : (
          <main className='flex-1 min-w-0 min-h-0 flex'>
            <RemotePeerChatPanel peer={session} fullWidth />
          </main>
        )}
      </div>
    </div>
  );
};

const CloudHeader: React.FC<{
  session: CloudWorkspaceConnection;
  cloud: UseCloudWorkspace;
  fileCount: number;
  sourceRootPath?: string | null;
  progress: UseCloudWorkspace['publishProgress'];
  pullProgress: UseCloudWorkspace['pullProgress'];
  onBack: () => void;
  onPublish: () => void;
  onPull: () => void;
}> = ({ session, cloud, fileCount, sourceRootPath, progress, pullProgress, onBack, onPublish, onPull }) => {
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
      <Tag size='small'>{t('ide.cloudWorkspace.filesLabel', { count: fileCount })}</Tag>
      <Tag size='small'>{t('ide.cloudWorkspace.participantsLabel', { count: participantCount })}</Tag>
      <span className='flex-1' />
      {progress?.running ? (
        <Tag size='small'>
          {progress.totalDiscovered > 0
            ? t('ide.cloudWorkspace.publishProgress', {
                uploaded: progress.uploaded,
                total: progress.totalDiscovered,
              })
            : t('ide.cloudWorkspace.publishStarting')}
        </Tag>
      ) : null}
      {pullProgress?.running ? (
        <Tag size='small'>
          {pullProgress.totalDiscovered > 0
            ? t('ide.cloudWorkspace.pullProgress', {
                pulled: pullProgress.uploaded,
                total: pullProgress.totalDiscovered,
              })
            : t('ide.cloudWorkspace.pullStarting')}
        </Tag>
      ) : null}
      <Tooltip content={sourceRootPath ? sourceRootPath : t('ide.cloudWorkspace.openLocalBeforePull')} mini>
        <Button
          size='mini'
          icon={<Download theme='outline' size={12} />}
          loading={cloud.pulling}
          disabled={fileCount === 0}
          onClick={onPull}
        >
          {t('ide.cloudWorkspace.pullCloud')}
        </Button>
      </Tooltip>
      <Tooltip content={sourceRootPath ? sourceRootPath : t('ide.cloudWorkspace.openLocalFirst')} mini>
        <Button size='mini' icon={<Upload theme='outline' size={12} />} loading={cloud.publishing} onClick={onPublish}>
          {t('ide.cloudWorkspace.publishLocal')}
        </Button>
      </Tooltip>
      <Button size='mini' status='danger' onClick={() => void cloud.disconnect()}>
        {t('ide.cloudWorkspace.disconnect')}
      </Button>
    </header>
  );
};

const CloudActivityItem: React.FC<{
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}> = ({ icon, label, active, onClick }) => (
  <Tooltip content={label} position='right' mini>
    <Button
      type={active ? 'primary' : 'text'}
      size='small'
      className='!w-42px !h-42px !px-0'
      icon={icon}
      onClick={onClick}
      aria-label={label}
    />
  </Tooltip>
);

const CloudEmptyState: React.FC<{
  canPublish: boolean;
  publishing: boolean;
  progress: UseCloudWorkspace['publishProgress'];
  error: string | null;
  onPublish: () => void;
  onPickLocalFolder?: () => void;
}> = ({ canPublish, publishing, progress, error, onPublish, onPickLocalFolder }) => {
  const { t } = useTranslation();
  return (
    <div className='h-full min-h-260px flex-center flex-col gap-12px px-12px text-center'>
      <span className='size-48px flex-center rd-12px bg-primary-light-1 text-primary'>
        <Cloudy theme='outline' size={24} />
      </span>
      <div className='flex flex-col gap-4px'>
        <span className='text-13px font-600 text-t-primary'>{t('ide.cloudWorkspace.emptyTitle')}</span>
        <span className='text-12px text-t-secondary leading-relaxed'>{t('ide.cloudWorkspace.emptyHint')}</span>
      </div>
      <Button
        type='primary'
        size='small'
        icon={<Upload theme='outline' size={13} />}
        loading={publishing}
        onClick={canPublish ? onPublish : onPickLocalFolder}
      >
        {canPublish ? t('ide.cloudWorkspace.publishLocal') : t('ide.cloudWorkspace.pickLocalFolder')}
      </Button>
      {progress?.running ? (
        <span className='max-w-220px truncate text-11px text-t-tertiary'>
          {progress.totalDiscovered > 0
            ? t('ide.cloudWorkspace.publishProgress', {
                uploaded: progress.uploaded,
                total: progress.totalDiscovered,
              })
            : t('ide.cloudWorkspace.publishStarting')}
          {progress.currentPath ? ` · ${progress.currentPath}` : ''}
        </span>
      ) : null}
      {error ? <span className='max-w-260px break-words text-11px text-danger'>{error}</span> : null}
    </div>
  );
};

const CloudEditorTabs: React.FC<{
  openFiles: string[];
  activeFile: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}> = ({ openFiles, activeFile, onSelect, onClose }) => (
  <div className='shrink-0 flex items-stretch gap-2px px-8px pt-6px overflow-x-auto border-b border-b-1'>
    {openFiles.map((filePath) => {
      const active = activeFile === filePath;
      const slash = filePath.lastIndexOf('/');
      const name = slash >= 0 ? filePath.slice(slash + 1) : filePath;
      return (
        <div
          key={filePath}
          aria-selected={active}
          title={filePath}
          className={`group flex items-center max-w-200px rd-t-8px border border-b-0 ${active ? 'bg-1 border-arco-2 text-t-primary' : 'bg-fill-1 border-transparent text-t-secondary hover:bg-fill-2'}`}
        >
          <Button
            type='text'
            size='mini'
            onClick={() => onSelect(filePath)}
            className='!min-w-0 !h-auto !flex-1 !justify-start !pl-12px !pr-4px !py-6px !text-inherit'
          >
            <span className='truncate text-12px'>{name}</span>
          </Button>
          <Button
            type='text'
            size='mini'
            icon={<Close theme='outline' size={11} />}
            onClick={() => onClose(filePath)}
            className='!shrink-0 !w-16px !h-16px !p-0 !rd-4px !text-t-tertiary hover:!bg-fill-3 hover:!text-t-primary'
          />
        </div>
      );
    })}
  </div>
);

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
