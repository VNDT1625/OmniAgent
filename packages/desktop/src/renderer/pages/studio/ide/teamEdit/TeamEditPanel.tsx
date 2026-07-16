/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `TeamEditPanel` — the IDE "Team" mode surface for Agent Team Edit.
 *
 * It shows, for the open workspace, WHO is working (agents + the user, with
 * presence colours) and WHICH files each one currently holds (an advisory
 * lease), plus a live activity feed (claims / writes / releases / conflicts).
 * The user can manually claim or release the lease on the active file so they
 * can carve out a file the agents must not touch.
 *
 * Light, presence-first collaboration: no per-keystroke co-typing — the point
 * is dividing work by file so multiple agents (and the user) never clobber each
 * other's edits. State is the Main-process coordinator's live snapshot.
 *
 * Renderer-only; all text via i18n; Arco + @icon-park + UnoCSS tokens only.
 */

import { Button, Empty, Spin, Tag, Tooltip } from '@arco-design/web-react';
import { FileEditingOne, Lock, Unlock, People, Refresh, Time } from '@icon-park/react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTeamEdit, USER_AGENT_ID } from './useTeamEdit';
import type { FileLease, TeamActivity, TeamParticipant } from './teamEditClient';
import type { UseTeamCollab } from './useTeamCollab';

type TeamEditPanelProps = {
  /** Absolute open workspace folder (null when none). */
  rootPath: string | null;
  /** Absolute path of the file open in the editor (for the manual claim button). */
  activeFile: string | null;
  /** Team-collab controller: when a `peer`, the panel reads the host's snapshot read-only. */
  collab: UseTeamCollab;
};

/** Workspace-relative, forward-slash path of an absolute file within `root`. */
const relWithinRoot = (abs: string, root: string): string => {
  const a = abs.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return a.startsWith(`${r}/`) ? a.slice(r.length + 1) : a;
};

/** Short relative time label (seconds/minutes) for the activity feed + leases. */
const useRelativeTime = (): ((at: number) => string) => {
  const { t } = useTranslation();
  return (at: number): string => {
    const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (secs < 60) return t('ide.team.time.secondsAgo', { count: secs });
    const mins = Math.round(secs / 60);
    return t('ide.team.time.minutesAgo', { count: mins });
  };
};

const TeamEditPanel: React.FC<TeamEditPanelProps> = ({ rootPath, activeFile, collab }) => {
  const { t } = useTranslation();
  const userLabel = t('ide.team.you');
  const local = useTeamEdit(rootPath, userLabel);
  const rel = useRelativeTime();

  // When a peer, the IDE reads the host's live snapshot (presence/leases/
  // activity) over HTTP and the manual claim/release controls are hidden — a
  // peer carves out files through the host's guarded write/edit, not locally.
  const isPeer = collab.role === 'peer';
  const snapshot = isPeer ? collab.remoteSnapshot : local.snapshot;
  const loading = isPeer ? collab.remoteSnapshot === null : local.loading;
  const { claim, release, refresh } = local;

  const activeRel = useMemo(
    () => (rootPath && activeFile ? relWithinRoot(activeFile, rootPath) : null),
    [rootPath, activeFile]
  );

  // The lease (if any) on the currently-open file, and who holds it.
  const activeLease = useMemo<FileLease | null>(() => {
    if (!activeRel || !snapshot) return null;
    return snapshot.leases.find((l) => l.relPath === activeRel) ?? null;
  }, [activeRel, snapshot]);

  const userHoldsActive = activeLease?.agentId === USER_AGENT_ID;
  const someoneElseHoldsActive = activeLease !== null && activeLease.agentId !== USER_AGENT_ID;

  if (!rootPath) {
    return (
      <div className='size-full flex-center'>
        <Empty description={t('ide.team.noFolder')} />
      </div>
    );
  }

  return (
    <div className='size-full flex flex-col min-h-0 bg-1'>
      <header className='shrink-0 flex items-center gap-8px h-44px px-16px border-b border-b-1'>
        <People theme='outline' size={16} className='text-primary' />
        <span className='text-13px font-[500] text-t-primary'>{t('ide.team.title')}</span>
        <span className='text-12px text-t-tertiary'>{t('ide.team.subtitle')}</span>
        <div className='flex-1' />
        <Tooltip content={t('ide.team.refresh')} mini>
          <Button
            type='text'
            size='mini'
            className='!text-t-secondary'
            icon={<Refresh theme='outline' size={14} />}
            onClick={() => void refresh()}
            aria-label={t('ide.team.refresh')}
          />
        </Tooltip>
      </header>

      {/* Active-file lease control (host/solo only — a peer claims via the host). */}
      {activeRel && !isPeer ? (
        <div className='shrink-0 flex items-center gap-10px px-16px py-10px border-b border-b-1 bg-2'>
          <FileEditingOne theme='outline' size={14} className='text-t-secondary shrink-0' />
          <span className='flex-1 min-w-0 truncate font-mono text-12px text-t-primary' title={activeRel}>
            {activeRel}
          </span>
          {someoneElseHoldsActive ? (
            <Tag color='red' size='small' icon={<Lock theme='outline' size={12} />}>
              {t('ide.team.heldBy', { who: activeLease?.agentId ?? '' })}
            </Tag>
          ) : userHoldsActive ? (
            <Button
              type='outline'
              size='mini'
              status='success'
              icon={<Unlock theme='outline' size={13} />}
              onClick={() => void release(activeRel)}
            >
              {t('ide.team.release')}
            </Button>
          ) : (
            <Button
              type='primary'
              size='mini'
              icon={<Lock theme='outline' size={13} />}
              onClick={() => void claim(activeRel, t('ide.team.userIntent'))}
            >
              {t('ide.team.claim')}
            </Button>
          )}
        </div>
      ) : null}

      {loading && !snapshot ? (
        <div className='flex-1 flex-center'>
          <Spin />
        </div>
      ) : (
        <div className='flex-1 min-h-0 overflow-auto p-16px flex flex-col gap-20px'>
          <ParticipantsSection participants={snapshot?.participants ?? []} relTime={rel} />
          <LeasesSection leases={snapshot?.leases ?? []} onRelease={(p) => void release(p)} relTime={rel} />
          <ActivitySection activity={snapshot?.activity ?? []} relTime={rel} />
        </div>
      )}
    </div>
  );
};

/** Presence list: everyone working in this workspace, with their colour dot. */
const ParticipantsSection: React.FC<{
  participants: TeamParticipant[];
  relTime: (at: number) => string;
}> = ({ participants, relTime }) => {
  const { t } = useTranslation();
  return (
    <section>
      <SectionTitle label={t('ide.team.participants')} count={participants.length} />
      {participants.length === 0 ? (
        <p className='m-0 text-12px text-t-tertiary'>{t('ide.team.noParticipants')}</p>
      ) : (
        <ul className='m-0 p-0 list-none flex flex-col gap-6px'>
          {participants.map((p) => (
            <li key={p.agentId} className='flex items-center gap-8px'>
              <span className='size-9px rd-full shrink-0' style={{ backgroundColor: p.color }} aria-hidden />
              <span className='text-12px text-t-primary truncate'>{p.label}</span>
              {p.isUser ? (
                <Tag size='small' color='arcoblue'>
                  {t('ide.team.youTag')}
                </Tag>
              ) : null}
              <div className='flex-1' />
              <span className='text-11px text-t-tertiary'>{relTime(p.lastSeenAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/** Held-files list: every live lease + who holds it (release for the user's own). */
const LeasesSection: React.FC<{
  leases: FileLease[];
  onRelease: (relPath: string) => void;
  relTime: (at: number) => string;
}> = ({ leases, onRelease, relTime }) => {
  const { t } = useTranslation();
  return (
    <section>
      <SectionTitle label={t('ide.team.heldFiles')} count={leases.length} />
      {leases.length === 0 ? (
        <p className='m-0 text-12px text-t-tertiary'>{t('ide.team.noLeases')}</p>
      ) : (
        <ul className='m-0 p-0 list-none flex flex-col gap-6px'>
          {leases.map((l) => {
            const slash = l.relPath.lastIndexOf('/');
            const name = slash >= 0 ? l.relPath.slice(slash + 1) : l.relPath;
            const dir = slash >= 0 ? l.relPath.slice(0, slash) : '';
            return (
              <li key={l.relPath} className='flex items-center gap-8px px-8px py-6px rd-6px bg-2'>
                <Lock theme='outline' size={13} className='text-t-tertiary shrink-0' />
                <span className='flex flex-col min-w-0 flex-1'>
                  <span className='text-12px text-t-primary font-mono truncate' title={l.relPath}>
                    {name}
                  </span>
                  <span className='text-10px text-t-tertiary truncate'>
                    {dir ? `${dir} · ` : ''}
                    {t('ide.team.heldBy', { who: l.agentId })}
                    {l.intent ? ` · ${l.intent}` : ''}
                  </span>
                </span>
                <span className='text-11px text-t-tertiary shrink-0'>{relTime(l.renewedAt)}</span>
                {l.agentId === USER_AGENT_ID ? (
                  <Tooltip content={t('ide.team.release')} mini>
                    <Button
                      type='text'
                      size='mini'
                      className='!text-t-secondary'
                      icon={<Unlock theme='outline' size={13} />}
                      onClick={() => onRelease(l.relPath)}
                      aria-label={t('ide.team.release')}
                    />
                  </Tooltip>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

/** Activity feed: the rolling claim/write/release/conflict log (newest first). */
const ActivitySection: React.FC<{
  activity: TeamActivity[];
  relTime: (at: number) => string;
}> = ({ activity, relTime }) => {
  const { t } = useTranslation();
  const ordered = useMemo(() => activity.toReversed(), [activity]);
  const describe = (a: TeamActivity): string => {
    const file = a.relPath ?? '';
    switch (a.kind) {
      case 'join':
        return t('ide.team.activity.join', { who: a.agentId });
      case 'claim':
        return t('ide.team.activity.claim', { who: a.agentId, file });
      case 'release':
        return t('ide.team.activity.release', { who: a.agentId, file });
      case 'write':
        return t('ide.team.activity.write', { who: a.agentId, file });
      case 'expire':
        return t('ide.team.activity.expire', { who: a.agentId, file });
      case 'conflict':
        return t('ide.team.activity.conflict', { who: a.agentId, file, holder: a.byAgentId ?? '' });
      default:
        return '';
    }
  };
  return (
    <section>
      <SectionTitle label={t('ide.team.activityTitle')} count={ordered.length} />
      {ordered.length === 0 ? (
        <p className='m-0 text-12px text-t-tertiary'>{t('ide.team.noActivity')}</p>
      ) : (
        <ul className='m-0 p-0 list-none flex flex-col gap-4px'>
          {ordered.map((a) => (
            <li key={a.seq} className='flex items-start gap-6px text-12px'>
              <Time
                theme='outline'
                size={12}
                className={`mt-3px shrink-0 ${a.kind === 'conflict' ? 'text-danger' : 'text-t-tertiary'}`}
              />
              <span className={`flex-1 min-w-0 ${a.kind === 'conflict' ? 'text-danger' : 'text-t-secondary'}`}>
                {describe(a)}
              </span>
              <span className='text-10px text-t-tertiary shrink-0'>{relTime(a.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/** A small uppercase section header with a count badge. */
const SectionTitle: React.FC<{ label: string; count: number }> = ({ label, count }) => (
  <p className='m-0 mb-8px text-11px font-600 text-t-tertiary uppercase tracking-wide'>
    {label} · {count}
  </p>
);

export default TeamEditPanel;
