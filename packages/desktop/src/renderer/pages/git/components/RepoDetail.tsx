/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `RepoDetail` — the right pane of the Git Manager for the selected repo. Shows:
 *  - a header: name + remote + local path + branch, with a Refresh + Remove,
 *  - a status strip: ahead/behind/changes badges,
 *  - the commit box (message + "Commit"),
 *  - the two-way action row: **Pull** (down / restore), **Push** (up / backup),
 *    and **Clone** (re-download) — each confirmed where it could overwrite,
 *  - the latest command output (token-redacted) so the user sees what git did.
 *
 * Push to a protected branch (main/master) is gated behind a confirm so a backup
 * never silently overwrites the mainline.
 *
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { Button, Input, Modal, Popconfirm, Tag, Tooltip } from '@arco-design/web-react';
import { CloudStorage, Delete, Download, Refresh, Upload } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitRepo, GitRepoStatus } from '@process/git/gitTypes';

type RepoDetailProps = {
  repo: GitRepo;
  status?: GitRepoStatus;
  busy: boolean;
  onRefresh: () => void;
  onClone: () => Promise<void>;
  onCommit: (message: string) => Promise<boolean>;
  onPush: () => Promise<void>;
  onPull: () => Promise<void>;
  onRemove: () => Promise<void>;
};

/** Branch names that warrant a confirm before pushing (mainline protection). */
const PROTECTED = new Set(['main', 'master']);

const RepoDetail: React.FC<RepoDetailProps> = ({
  repo,
  status,
  busy,
  onRefresh,
  onClone,
  onCommit,
  onPush,
  onPull,
  onRemove,
}) => {
  const { t } = useTranslation();
  const [commitMsg, setCommitMsg] = useState('');

  const branch = status?.branch ?? repo.branch;
  const isProtected = PROTECTED.has(branch.toLowerCase());

  const doCommit = async (): Promise<void> => {
    if (!commitMsg.trim()) return;
    const ok = await onCommit(commitMsg.trim());
    if (ok) setCommitMsg('');
  };

  const confirmPush = (): void => {
    if (isProtected) {
      Modal.confirm({
        title: t('git.detail.pushProtectedTitle'),
        content: t('git.detail.pushProtectedBody', { branch }),
        okText: t('git.detail.pushAnyway'),
        cancelText: t('common.cancel'),
        okButtonProps: { status: 'warning' },
        onOk: () => void onPush(),
      });
      return;
    }
    void onPush();
  };

  return (
    <div className='flex flex-col h-full min-h-0'>
      {/* Header */}
      <div className='shrink-0 flex items-start gap-12px px-20px py-14px border-b border-b-1'>
        <div className='flex flex-col min-w-0 flex-1 gap-3px'>
          <span className='text-15px font-600 text-t-primary truncate'>{repo.name}</span>
          <span className='text-12px text-t-secondary font-mono truncate' title={repo.remoteUrl}>
            {repo.remoteUrl}
          </span>
          <span className='text-11px text-t-tertiary font-mono truncate' title={repo.localPath}>
            {repo.localPath}
          </span>
        </div>
        <Tag color='arcoblue' size='small' className='!text-11px shrink-0'>
          {branch}
        </Tag>
        <Tooltip content={t('git.detail.refresh')} mini>
          <Button
            type='text'
            size='small'
            icon={<Refresh theme='outline' size={15} />}
            loading={busy}
            onClick={onRefresh}
            className='!text-t-secondary'
          />
        </Tooltip>
        <Popconfirm
          title={t('git.detail.removeConfirm')}
          content={t('git.detail.removeHint')}
          okText={t('git.detail.remove')}
          cancelText={t('common.cancel')}
          okButtonProps={{ status: 'danger' }}
          onOk={() => void onRemove()}
        >
          <Tooltip content={t('git.detail.remove')} mini>
            <Button type='text' size='small' status='danger' icon={<Delete theme='outline' size={15} />} />
          </Tooltip>
        </Popconfirm>
      </div>

      {/* Status strip */}
      <div className='shrink-0 flex items-center gap-8px px-20px py-10px border-b border-b-1 bg-fill-1'>
        {!status?.isRepo ? (
          <span className='text-12px text-warning'>{t('git.detail.notCloned')}</span>
        ) : (
          <>
            <StatusPill
              label={t('git.detail.changed')}
              value={status.changedCount}
              tone={status.changedCount > 0 ? 'warning' : 'muted'}
            />
            <StatusPill
              label={t('git.detail.ahead')}
              value={status.ahead}
              tone={status.ahead > 0 ? 'primary' : 'muted'}
            />
            <StatusPill
              label={t('git.detail.behind')}
              value={status.behind}
              tone={status.behind > 0 ? 'danger' : 'muted'}
            />
            {!status.hasRemote ? <Tag size='small'>{t('git.detail.noRemote')}</Tag> : null}
          </>
        )}
      </div>

      {/* Scrollable body */}
      <div className='flex-1 min-h-0 overflow-y-auto px-20px py-16px flex flex-col gap-16px'>
        {/* Commit box */}
        <section className='flex flex-col gap-8px'>
          <span className='text-12px font-600 text-t-secondary uppercase tracking-wide'>
            {t('git.detail.commitSection')}
          </span>
          <Input.TextArea
            value={commitMsg}
            onChange={setCommitMsg}
            placeholder={t('git.detail.commitPlaceholder')}
            autoSize={{ minRows: 2, maxRows: 5 }}
            disabled={busy}
            className='!text-13px font-mono'
          />
          <Button
            type='primary'
            size='small'
            className='self-start'
            loading={busy}
            disabled={!commitMsg.trim()}
            onClick={() => void doCommit()}
          >
            {t('git.detail.commit')}
          </Button>
        </section>

        {/* Two-way sync actions */}
        <section className='flex flex-col gap-8px'>
          <span className='text-12px font-600 text-t-secondary uppercase tracking-wide'>
            {t('git.detail.syncSection')}
          </span>
          <div className='flex flex-wrap items-center gap-8px'>
            <Tooltip content={t('git.detail.pullHint')} position='top'>
              <Button icon={<Download theme='outline' size={15} />} loading={busy} onClick={() => void onPull()}>
                {t('git.detail.pull')}
              </Button>
            </Tooltip>
            <Tooltip content={t('git.detail.pushHint')} position='top'>
              <Button type='primary' icon={<Upload theme='outline' size={15} />} loading={busy} onClick={confirmPush}>
                {t('git.detail.push')}
              </Button>
            </Tooltip>
            <Tooltip content={t('git.detail.cloneHint')} position='top'>
              <Button icon={<CloudStorage theme='outline' size={15} />} loading={busy} onClick={() => void onClone()}>
                {t('git.detail.clone')}
              </Button>
            </Tooltip>
          </div>
          <span className='text-11px text-t-tertiary'>{t('git.detail.syncHint')}</span>
        </section>
      </div>
    </div>
  );
};

/** A small labelled count pill in the status strip. */
const StatusPill: React.FC<{ label: string; value: number; tone: 'primary' | 'warning' | 'danger' | 'muted' }> = ({
  label,
  value,
  tone,
}) => {
  const toneClass =
    tone === 'primary'
      ? 'text-primary'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-t-tertiary';
  return (
    <span className='flex items-center gap-4px'>
      <span className={`text-13px font-700 ${toneClass}`}>{value}</span>
      <span className='text-11px text-t-tertiary'>{label}</span>
    </span>
  );
};

export default RepoDetail;
