/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `TeamCollabBar` — the publish/join control strip at the top of the IDE Team
 * panel.
 *
 * Three states (driven by {@link useTeamCollab}):
 *  - `none` — buttons to **Publish** the open repo (host) or **Join** a remote
 *    host (peer) via a modal.
 *  - `host` — shows the join code (LAN `ip:port`) or the public tunnel URL +
 *    the password, with copy buttons, and a Stop button.
 *  - `peer` — shows which host repo you joined, read-only reminder, and a Leave
 *    button.
 *
 * Renderer-only; Arco + @icon-park + UnoCSS tokens; all text via i18n.
 */

import { Button, Input, Message, Modal, Switch, Tag, Tooltip } from '@arco-design/web-react';
import { Copy, Earth, Local, Logout, Share } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TeamRole, UseTeamCollab } from './useTeamCollab';

type TeamCollabBarProps = {
  /** Whether a folder is open (publishing needs one). */
  hasFolder: boolean;
  /** The team-collab controller from {@link useTeamCollab}. */
  collab: UseTeamCollab;
};

/** Copy text to the clipboard with a toast. */
const useCopy = (): ((text: string, toast: string) => void) => {
  return (text, toast) =>
    void navigator.clipboard?.writeText(text).then(
      () => Message.success(toast),
      (): undefined => undefined
    );
};

const TeamCollabBar: React.FC<TeamCollabBarProps> = ({ hasFolder, collab }) => {
  const { t } = useTranslation();
  const copy = useCopy();
  const [modal, setModal] = useState<null | 'publish' | 'join'>(null);

  // Publish form.
  const [password, setPassword] = useState('123456');
  const [online, setOnline] = useState(false);
  // Join form.
  const [joinUrl, setJoinUrl] = useState('');
  const [joinPassword, setJoinPassword] = useState('123456');
  const [joinName, setJoinName] = useState('');

  const doPublish = async (): Promise<void> => {
    if (online && (password.trim().length < 6 || password === '123456')) {
      Message.warning(t('ide.teamCollab.weakPassword'));
      return;
    }
    const ok = await collab.publish(password, online);
    if (ok) setModal(null);
  };

  const doJoin = async (): Promise<void> => {
    // Accept either a bare `ip:port` or a full URL; normalise to a base URL.
    const raw = joinUrl.trim();
    if (!raw) return;
    const baseUrl = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
    const ok = await collab.join(baseUrl, joinPassword, joinName || t('ide.team.you'));
    if (ok) setModal(null);
  };

  return (
    <div className='shrink-0 flex items-center gap-8px px-16px py-8px border-b border-b-1 bg-2'>
      <RoleTag role={collab.role} />
      <div className='flex-1 min-w-0'>
        {collab.role === 'host' && collab.publishInfo ? (
          <HostInfo
            joinValue={collab.publishInfo.online ? (collab.publishInfo.joinUrl ?? '') : collab.publishInfo.joinCode}
            online={collab.publishInfo.online}
            onCopy={(v) => copy(v, t('ide.teamCollab.copied'))}
          />
        ) : collab.role === 'peer' && collab.peer ? (
          <span className='text-12px text-t-secondary truncate'>
            {t('ide.teamCollab.joinedRepo', { repo: collab.peer.repoName })} · {t('ide.teamCollab.readOnlyNote')}
          </span>
        ) : (
          <span className='text-12px text-t-tertiary'>{t('ide.teamCollab.idleHint')}</span>
        )}
      </div>

      {collab.role === 'none' ? (
        <>
          <Tooltip content={hasFolder ? '' : t('ide.teamCollab.needFolder')} disabled={hasFolder} mini>
            <Button
              type='primary'
              size='mini'
              icon={<Share theme='outline' size={13} />}
              disabled={!hasFolder}
              loading={collab.busy}
              onClick={() => setModal('publish')}
            >
              {t('ide.teamCollab.publish')}
            </Button>
          </Tooltip>
          <Button size='mini' icon={<Local theme='outline' size={13} />} onClick={() => setModal('join')}>
            {t('ide.teamCollab.join')}
          </Button>
        </>
      ) : collab.role === 'host' ? (
        <Button size='mini' status='danger' onClick={() => void collab.unpublish()}>
          {t('ide.teamCollab.stop')}
        </Button>
      ) : (
        <Button
          size='mini'
          status='danger'
          icon={<Logout theme='outline' size={13} />}
          onClick={() => void collab.leave()}
        >
          {t('ide.teamCollab.leave')}
        </Button>
      )}

      {/* Publish modal */}
      <Modal
        title={t('ide.teamCollab.publishTitle')}
        visible={modal === 'publish'}
        onCancel={() => setModal(null)}
        onOk={() => void doPublish()}
        confirmLoading={collab.busy}
        okText={t('ide.teamCollab.publish')}
        autoFocus={false}
      >
        <div className='flex flex-col gap-12px'>
          <label className='flex flex-col gap-4px'>
            <span className='text-12px text-t-secondary'>{t('ide.teamCollab.password')}</span>
            <Input.Password value={password} onChange={setPassword} placeholder='123456' />
          </label>
          <div className='flex items-center justify-between'>
            <span className='flex flex-col'>
              <span className='text-13px text-t-primary inline-flex items-center gap-6px'>
                <Earth theme='outline' size={14} />
                {t('ide.teamCollab.onlineLabel')}
              </span>
              <span className='text-11px text-t-tertiary'>{t('ide.teamCollab.onlineHint')}</span>
            </span>
            <Switch checked={online} onChange={setOnline} />
          </div>
          {collab.error ? <span className='text-12px text-danger'>{collab.error}</span> : null}
        </div>
      </Modal>

      {/* Join modal */}
      <Modal
        title={t('ide.teamCollab.joinTitle')}
        visible={modal === 'join'}
        onCancel={() => setModal(null)}
        onOk={() => void doJoin()}
        confirmLoading={collab.busy}
        okText={t('ide.teamCollab.join')}
        autoFocus={false}
      >
        <div className='flex flex-col gap-12px'>
          <label className='flex flex-col gap-4px'>
            <span className='text-12px text-t-secondary'>{t('ide.teamCollab.joinCodeLabel')}</span>
            <Input value={joinUrl} onChange={setJoinUrl} placeholder={t('ide.teamCollab.joinCodePlaceholder')} />
          </label>
          <label className='flex flex-col gap-4px'>
            <span className='text-12px text-t-secondary'>{t('ide.teamCollab.password')}</span>
            <Input.Password value={joinPassword} onChange={setJoinPassword} placeholder='123456' />
          </label>
          <label className='flex flex-col gap-4px'>
            <span className='text-12px text-t-secondary'>{t('ide.teamCollab.yourName')}</span>
            <Input value={joinName} onChange={setJoinName} placeholder={t('ide.teamCollab.namePlaceholder')} />
          </label>
          {collab.error ? <span className='text-12px text-danger'>{collab.error}</span> : null}
        </div>
      </Modal>
    </div>
  );
};

/** A small colored tag for the current role. */
const RoleTag: React.FC<{ role: TeamRole }> = ({ role }) => {
  const { t } = useTranslation();
  if (role === 'host')
    return (
      <Tag color='green' size='small'>
        {t('ide.teamCollab.roleHost')}
      </Tag>
    );
  if (role === 'peer')
    return (
      <Tag color='arcoblue' size='small'>
        {t('ide.teamCollab.rolePeer')}
      </Tag>
    );
  return <Tag size='small'>{t('ide.teamCollab.roleNone')}</Tag>;
};

/** Host's shareable join value + copy button. */
const HostInfo: React.FC<{ joinValue: string; online: boolean; onCopy: (v: string) => void }> = ({
  joinValue,
  online,
  onCopy,
}) => {
  const { t } = useTranslation();
  return (
    <span className='flex items-center gap-6px min-w-0'>
      <span className='text-11px text-t-tertiary shrink-0'>
        {online ? t('ide.teamCollab.publicUrl') : t('ide.teamCollab.lanCode')}
      </span>
      <code className='text-12px text-t-primary truncate font-mono' title={joinValue}>
        {joinValue || '—'}
      </code>
      {joinValue ? (
        <Tooltip content={t('ide.teamCollab.copy')} mini>
          <Button
            type='text'
            size='mini'
            className='!text-t-secondary'
            icon={<Copy theme='outline' size={12} />}
            onClick={() => onCopy(joinValue)}
          />
        </Tooltip>
      ) : null}
    </span>
  );
};

export default TeamCollabBar;
