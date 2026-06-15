/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Status board (Requirement 3 "Phần 2"): a live grid of who-is-doing-what and
 * who-is-talking-to-whom during a company conversation. Each participant is a
 * card whose accent + pulse reflects its current {@link ParticipantActivity}.
 *
 * Renderer-only. Arco + UnoCSS semantic tokens; all copy via i18n.
 */

import type { Participant, ParticipantStatus } from '@process/company/companyConversation';
import { Crown, Effects, PeopleSpeak, User } from '@icon-park/react';
import { Tag, Tooltip } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

/** Map an activity to a tokenised accent + Arco tag color. */
const activityStyle = (activity: ParticipantStatus['activity']): { tag: string; dot: string } => {
  switch (activity) {
    case 'thinking':
      return { tag: 'arcoblue', dot: 'bg-primary' };
    case 'speaking':
      return { tag: 'cyan', dot: 'bg-success' };
    case 'awaiting-approval':
      return { tag: 'orange', dot: 'bg-warning' };
    case 'done':
      return { tag: 'green', dot: 'bg-success' };
    case 'failed':
      return { tag: 'red', dot: 'bg-danger' };
    default:
      return { tag: 'gray', dot: 'bg-3' };
  }
};

/** One participant card. */
const ParticipantCard: React.FC<{
  participant: Participant;
  status?: ParticipantStatus;
  nameById: Record<string, string>;
}> = ({ participant, status, nameById }) => {
  const { t } = useTranslation();
  const activity = status?.activity ?? 'idle';
  const style = activityStyle(activity);
  const isPresident = participant.role === 'president';
  const live = activity === 'thinking' || activity === 'speaking' || activity === 'awaiting-approval';
  const talkingTo = status?.talkingToId ? nameById[status.talkingToId] : undefined;

  return (
    <div
      className={`relative flex flex-col gap-8px rd-12px border border-solid p-12px transition-all duration-200 ${
        live ? 'border-primary bg-primary-1' : 'border-b-1 bg-1'
      }`}
    >
      <div className='flex items-center gap-8px'>
        <span
          className={`size-28px flex-center rd-8px ${isPresident ? 'bg-primary text-color-white' : 'bg-fill-2 text-t-secondary'}`}
        >
          {isPresident ? <Crown theme='filled' size='16' /> : <User theme='outline' size='16' />}
        </span>
        <div className='min-w-0 flex-1'>
          <p className='m-0 truncate text-13px font-600 text-t-primary'>{participant.name}</p>
          <p className='m-0 truncate text-11px text-t-tertiary'>
            {t(
              isPresident
                ? 'company.role.president'
                : participant.role === 'division-head'
                  ? 'company.role.divisionHead'
                  : 'company.role.worker'
            )}
            {participant.executor ? ` · ${participant.executor}` : ''}
          </p>
        </div>
        <span className={`size-8px rd-full ${style.dot} ${live ? 'animate-pulse' : ''}`} />
      </div>

      <div className='flex items-center gap-6px'>
        <Tag color={style.tag} size='small' bordered>
          {t(`company.conversation.activity.${activity}`)}
        </Tag>
        {talkingTo && (
          <span className='flex items-center gap-3px text-11px text-t-secondary'>
            <PeopleSpeak theme='outline' size='12' />
            {talkingTo}
          </span>
        )}
      </div>

      {status?.task && (
        <Tooltip content={status.task} mini>
          <p className='m-0 line-clamp-2 text-11px text-t-tertiary'>{status.task}</p>
        </Tooltip>
      )}
    </div>
  );
};

/** The full status board grid. */
const StatusBoard: React.FC<{
  participants: Participant[];
  statuses: Record<string, ParticipantStatus>;
}> = ({ participants, statuses }) => {
  const { t } = useTranslation();
  const nameById = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of participants) map[p.id] = p.name;
    return map;
  }, [participants]);

  if (participants.length === 0) {
    return (
      <div className='flex flex-col items-center gap-10px py-32px text-center'>
        <span className='size-40px flex-center rd-full bg-fill-2 text-t-tertiary'>
          <Effects theme='outline' size='20' />
        </span>
        <p className='m-0 max-w-320px text-12px text-t-tertiary'>{t('company.conversation.boardEmpty')}</p>
      </div>
    );
  }

  const president = participants.find((p) => p.role === 'president');
  const reports = participants.filter((p) => p.role !== 'president');

  return (
    <div className='flex flex-col gap-12px'>
      {president && <ParticipantCard participant={president} status={statuses[president.id]} nameById={nameById} />}
      {reports.length > 0 && (
        <div className='grid grid-cols-1 sm:grid-cols-2 gap-10px'>
          {reports.map((p) => (
            <ParticipantCard key={p.id} participant={p} status={statuses[p.id]} nameById={nameById} />
          ))}
        </div>
      )}
    </div>
  );
};

export default StatusBoard;
