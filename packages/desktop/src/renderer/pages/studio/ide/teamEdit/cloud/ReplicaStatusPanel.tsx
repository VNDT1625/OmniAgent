/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Compact production status and conflict workflow for a bound local replica. */

import { Alert, Button, Input, Modal, Tag } from '@arco-design/web-react';
import { Caution, Refresh } from '@icon-park/react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReplicaConflict } from '@process/ide/teamEdit/cloud/cloudReplicaTypes';
import type { UseCloudWorkspace } from './useCloudWorkspace';

const stateKeys = {
  idle: 'ide.cloudWorkspace.replica.state.idle',
  scanning: 'ide.cloudWorkspace.replica.state.scanning',
  syncing: 'ide.cloudWorkspace.replica.state.syncing',
  offline: 'ide.cloudWorkspace.replica.state.offline',
  conflict: 'ide.cloudWorkspace.replica.state.conflict',
  error: 'ide.cloudWorkspace.replica.state.error',
} as const;

const stateColor = (state: NonNullable<UseCloudWorkspace['replica']>['state']): string | undefined => {
  if (state === 'idle') return 'green';
  if (state === 'offline') return 'orange';
  if (state === 'conflict' || state === 'error') return 'red';
  return 'arcoblue';
};

const conflictDraft = (conflict: ReplicaConflict): string =>
  ['<<<<<<< LOCAL', conflict.localContent, '=======', conflict.remoteContent, '>>>>>>> REMOTE'].join('\n');

const ReplicaStatusPanel: React.FC<{ cloud: UseCloudWorkspace }> = ({ cloud }) => {
  const { t } = useTranslation();
  const replica = cloud.replica;
  const [resolving, setResolving] = useState<ReplicaConflict | null>(null);
  const [draft, setDraft] = useState('');
  const [busyConflictId, setBusyConflictId] = useState<string | null>(null);
  const stateLabel = useMemo(() => (replica ? t(stateKeys[replica.state]) : ''), [replica, t]);

  if (!replica) return null;

  const resolve = async (
    conflict: ReplicaConflict,
    resolution: 'local' | 'remote' | 'merged',
    mergedContent?: string
  ): Promise<void> => {
    setBusyConflictId(conflict.id);
    const ok = await cloud.resolveConflict(conflict.id, resolution, mergedContent);
    setBusyConflictId(null);
    if (ok) setResolving(null);
  };

  return (
    <div className='shrink-0 border-b border-b-1 bg-2'>
      <div className='flex items-center gap-8px px-16px py-7px'>
        <Tag color={stateColor(replica.state)} size='small'>
          {stateLabel}
        </Tag>
        <span className='text-12px text-t-secondary truncate flex-1'>
          {replica.pendingFiles > 0
            ? t('ide.cloudWorkspace.replica.pending', { count: replica.pendingFiles })
            : t('ide.cloudWorkspace.replica.synced', { seq: replica.lastSyncedSeq })}
        </span>
        <Button
          type='text'
          size='mini'
          icon={<Refresh theme='outline' size={13} />}
          loading={replica.state === 'scanning' || replica.state === 'syncing'}
          onClick={() => void cloud.syncNow()}
        >
          {t('ide.cloudWorkspace.replica.syncNow')}
        </Button>
      </div>

      {replica.state === 'offline' ? (
        <Alert className='!mx-12px !mb-8px' type='warning' content={t('ide.cloudWorkspace.replica.offlineHint')} />
      ) : null}

      {replica.conflicts.length > 0 ? (
        <div className='px-12px pb-10px flex flex-col gap-6px'>
          {replica.conflicts.map((conflict) => (
            <div key={conflict.id} className='flex items-center gap-8px px-10px py-7px rd-6px border border-b-1 bg-1'>
              <Caution theme='outline' size={14} className='text-warning shrink-0' />
              <span className='text-12px text-t-primary font-mono truncate flex-1'>{conflict.relPath}</span>
              <Button
                size='mini'
                loading={busyConflictId === conflict.id}
                onClick={() => void resolve(conflict, 'local')}
              >
                {t('ide.cloudWorkspace.replica.keepLocal')}
              </Button>
              <Button
                size='mini'
                loading={busyConflictId === conflict.id}
                onClick={() => void resolve(conflict, 'remote')}
              >
                {t('ide.cloudWorkspace.replica.keepRemote')}
              </Button>
              {conflict.localHash &&
              conflict.remoteHash &&
              conflict.localEncoding === 'utf8' &&
              conflict.remoteEncoding === 'utf8' ? (
                <Button
                  type='primary'
                  size='mini'
                  onClick={() => {
                    setResolving(conflict);
                    setDraft(conflictDraft(conflict));
                  }}
                >
                  {t('ide.cloudWorkspace.replica.merge')}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <Modal
        title={t('ide.cloudWorkspace.replica.mergeTitle', { file: resolving?.relPath ?? '' })}
        visible={resolving !== null}
        onCancel={() => setResolving(null)}
        onOk={() => resolving && void resolve(resolving, 'merged', draft)}
        confirmLoading={resolving ? busyConflictId === resolving.id : false}
        okText={t('ide.cloudWorkspace.replica.saveMerge')}
        autoFocus={false}
        className='!w-760px'
      >
        <p className='mt-0 text-12px text-t-secondary'>{t('ide.cloudWorkspace.replica.mergeHint')}</p>
        <Input.TextArea
          value={draft}
          onChange={setDraft}
          autoSize={{ minRows: 14, maxRows: 24 }}
          className='!font-mono !text-12px'
        />
      </Modal>
    </div>
  );
};

export default ReplicaStatusPanel;
