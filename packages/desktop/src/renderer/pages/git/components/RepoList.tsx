/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `RepoList` — the left rail of the Git Manager: one row per registered repo
 * with its name, remote host, current branch, and an ahead/behind badge. The
 * active repo is highlighted; a spinner shows on the repo running a long op.
 *
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { Spin } from '@arco-design/web-react';
import { Branch } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { GitRepo, GitRepoStatus } from '@process/git/gitTypes';

type RepoListProps = {
  repos: GitRepo[];
  statuses: Record<string, GitRepoStatus>;
  activeId: string | null;
  busyRepoId: string | null;
  onSelect: (id: string) => void;
};

/** Parse the host from a remote URL for a compact subtitle. */
const hostOf = (url: string): string => {
  const m = url.match(/^(?:https?:\/\/)?([^/:]+)/i);
  return m?.[1] ?? url;
};

const RepoList: React.FC<RepoListProps> = ({ repos, statuses, activeId, busyRepoId, onSelect }) => {
  const { t } = useTranslation();
  return (
    <aside className='w-280px shrink-0 min-h-0 overflow-y-auto border-r border-b-1 py-6px'>
      {repos.map((repo) => {
        const active = repo.id === activeId;
        const status = statuses[repo.id];
        const busy = busyRepoId === repo.id;
        return (
          <button
            key={repo.id}
            type='button'
            onClick={() => onSelect(repo.id)}
            className={`w-full flex items-center gap-10px px-14px py-10px cursor-pointer border-none text-left transition-colors ${active ? 'bg-primary-light-1' : 'bg-transparent hover:bg-fill-2'}`}
          >
            <span
              className={`size-32px shrink-0 flex-center rd-9px ${active ? 'bg-primary text-white' : 'bg-fill-2 text-t-secondary'}`}
            >
              <Branch theme='outline' size={16} />
            </span>
            <span className='flex flex-col min-w-0 flex-1'>
              <span className='truncate text-13px font-600 text-t-primary'>{repo.name}</span>
              <span className='truncate text-11px text-t-tertiary'>{hostOf(repo.remoteUrl)}</span>
            </span>
            {busy ? (
              <Spin size={14} className='shrink-0' />
            ) : status ? (
              <span className='shrink-0 flex flex-col items-end gap-2px'>
                <span className='text-10px text-t-tertiary'>{status.branch ?? repo.branch}</span>
                {status.ahead > 0 || status.behind > 0 ? (
                  <span className='text-10px font-600 text-primary'>
                    {status.ahead > 0 ? `↑${status.ahead}` : ''}
                    {status.behind > 0 ? ` ↓${status.behind}` : ''}
                  </span>
                ) : status.changedCount > 0 ? (
                  <span className='text-10px font-600 text-warning'>
                    {t('git.list.changes', { count: status.changedCount })}
                  </span>
                ) : null}
              </span>
            ) : null}
          </button>
        );
      })}
    </aside>
  );
};

export default RepoList;
