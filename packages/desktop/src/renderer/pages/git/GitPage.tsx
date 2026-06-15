/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `GitPage` — the Git Manager (a Studio sub-app). A real GitHub-backed repo
 * manager: register a repo by URL + token, clone it down, commit + push local
 * changes up, pull updates back, and keep a two-way backup.
 *
 * Layout: a left rail listing registered repos (+ "Register" and "Credentials"
 * actions) and a right detail pane showing the selected repo's status, changes,
 * commit box, and push/pull/clone actions. Desktop-only: the Git Manager talks
 * to a native Main-process git runner, so the page hides in WebUI mode.
 *
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { Button, Empty, Message } from '@arco-design/web-react';
import { Branch, Left, Plus, Key, Refresh } from '@icon-park/react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { useGitManager } from './useGitManager';
import RepoList from './components/RepoList';
import RepoDetail from './components/RepoDetail';
import RegisterRepoModal from './components/RegisterRepoModal';
import CredentialsModal from './components/CredentialsModal';

type GitPageProps = {
  /** Optional back handler — shown as a back button (used by the Studio shell). */
  onBack?: () => void;
};

const GitPage: React.FC<GitPageProps> = ({ onBack }) => {
  const { t } = useTranslation();
  const git = useGitManager();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [credsOpen, setCredsOpen] = useState(false);

  const activeRepo = useMemo(() => git.repos.find((r) => r.id === activeId) ?? null, [git.repos, activeId]);

  // Auto-select the first repo when the list loads / changes.
  React.useEffect(() => {
    if (!activeId && git.repos.length > 0) setActiveId(git.repos[0].id);
    if (activeId && !git.repos.some((r) => r.id === activeId)) setActiveId(git.repos[0]?.id ?? null);
  }, [git.repos, activeId]);

  if (!isElectronDesktop()) {
    return (
      <div className='flex-1 flex-center p-32px'>
        <Empty description={t('git.desktopOnly')} />
      </div>
    );
  }

  return (
    <div className='flex flex-col h-full min-h-0'>
      {/* Header */}
      <div className='shrink-0 flex items-center gap-12px px-20px h-60px border-b border-b-1'>
        {onBack ? (
          <Button type='text' icon={<Left theme='outline' size={18} />} className='!text-t-secondary' onClick={onBack}>
            {t('studio.action.back')}
          </Button>
        ) : null}
        <span className='size-34px flex-center rd-10px bg-primary-light-1 text-primary'>
          <Branch theme='outline' size={18} />
        </span>
        <div className='flex flex-col min-w-0'>
          <span className='text-15px font-600 text-t-primary leading-tight'>{t('git.title')}</span>
          <span className='text-12px text-t-tertiary truncate'>{t('git.subtitle')}</span>
        </div>
        <div className='flex-1' />
        <Button icon={<Key theme='outline' size={14} />} onClick={() => setCredsOpen(true)}>
          {t('git.credentials.manage')}
        </Button>
        <Button type='primary' icon={<Plus theme='outline' size={14} />} onClick={() => setRegisterOpen(true)}>
          {t('git.register.action')}
        </Button>
      </div>

      {/* Body */}
      {git.status === 'unavailable' ? (
        <div className='flex-1 flex-center flex-col gap-12px text-center'>
          <span className='size-48px flex-center rd-full bg-fill-2 text-t-tertiary'>
            <Branch theme='outline' size={24} />
          </span>
          <p className='m-0 max-w-360px text-13px text-t-secondary'>{t('git.unavailable')}</p>
          <Button icon={<Refresh theme='outline' size={14} />} onClick={git.retry}>
            {t('git.retry')}
          </Button>
        </div>
      ) : git.repos.length === 0 ? (
        <div className='flex-1 flex-center flex-col gap-14px text-center'>
          <span className='size-56px flex-center rd-16px bg-primary-light-1 text-primary'>
            <Branch theme='outline' size={28} />
          </span>
          <p className='m-0 text-15px font-600 text-t-primary'>{t('git.empty.title')}</p>
          <p className='m-0 max-w-420px text-13px text-t-secondary leading-relaxed'>{t('git.empty.hint')}</p>
          <Button type='primary' icon={<Plus theme='outline' size={14} />} onClick={() => setRegisterOpen(true)}>
            {t('git.register.action')}
          </Button>
        </div>
      ) : (
        <div className='flex-1 min-h-0 flex'>
          <RepoList
            repos={git.repos}
            statuses={git.repoStatuses}
            activeId={activeId}
            busyRepoId={git.busyRepoId}
            onSelect={setActiveId}
          />
          <div className='flex-1 min-w-0 min-h-0'>
            {activeRepo ? (
              <RepoDetail
                repo={activeRepo}
                status={git.repoStatuses[activeRepo.id]}
                busy={git.busyRepoId === activeRepo.id}
                onRefresh={() => void git.refreshStatus(activeRepo.id)}
                onClone={async () => {
                  const res = await git.clone(activeRepo.id);
                  if (res) Message[res.ok ? 'success' : 'error'](res.ok ? t('git.op.cloned') : t('git.op.cloneFailed'));
                }}
                onCommit={async (message) => {
                  const res = await git.commit(activeRepo.id, message);
                  if (res)
                    Message[res.ok ? 'success' : 'error'](res.ok ? t('git.op.committed') : t('git.op.commitFailed'));
                  return Boolean(res?.ok);
                }}
                onPush={async () => {
                  const res = await git.push(activeRepo.id);
                  if (res) Message[res.ok ? 'success' : 'error'](res.ok ? t('git.op.pushed') : t('git.op.pushFailed'));
                }}
                onPull={async () => {
                  const res = await git.pull(activeRepo.id);
                  if (res) Message[res.ok ? 'success' : 'error'](res.ok ? t('git.op.pulled') : t('git.op.pullFailed'));
                }}
                onRemove={async () => {
                  await git.removeRepo(activeRepo.id);
                  Message.success(t('git.op.removed'));
                }}
              />
            ) : (
              <div className='size-full flex-center'>
                <Empty description={t('git.selectRepo')} />
              </div>
            )}
          </div>
        </div>
      )}

      <RegisterRepoModal
        open={registerOpen}
        credentials={git.credentials}
        busy={git.busyRepoId === '__register__'}
        onClose={() => setRegisterOpen(false)}
        onManageCredentials={() => {
          setRegisterOpen(false);
          setCredsOpen(true);
        }}
        onSubmit={async (req) => {
          const repo = await git.registerRepo(req);
          if (repo) {
            setActiveId(repo.id);
            setRegisterOpen(false);
            Message.success(t('git.register.added'));
          } else {
            Message.error(t('git.register.failed'));
          }
        }}
      />

      <CredentialsModal
        open={credsOpen}
        credentials={git.credentials}
        onClose={() => setCredsOpen(false)}
        onAdd={async (req) => {
          const ok = await git.addCredential(req);
          Message[ok ? 'success' : 'error'](ok ? t('git.credentials.added') : t('git.credentials.addFailed'));
          return ok;
        }}
        onRemove={async (id) => {
          await git.removeCredential(id);
          Message.success(t('git.credentials.removed'));
        }}
      />
    </div>
  );
};

export default GitPage;
