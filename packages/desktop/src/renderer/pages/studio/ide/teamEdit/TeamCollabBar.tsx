/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
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
import { Cloudy, Copy, Earth, Local, Logout, Share } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TeamRole, UseTeamCollab } from './useTeamCollab';
import type { UseCloudWorkspace } from './cloud/useCloudWorkspace';

const DEFAULT_CLOUD_RELAY_URL = 'https://aionui-cloud-relay.omniagentic.workers.dev';

type TeamCollabBarProps = {
  /** Local working tree bound to the collaboration session. */
  rootPath: string | null;
  /** The team-collab controller from {@link useTeamCollab}. */
  collab: UseTeamCollab;
  /** Cloud-authoritative workspace controller. */
  cloud: UseCloudWorkspace;
};

/** Copy text to the clipboard with a toast. */
const useCopy = (): ((text: string, toast: string) => void) => {
  return (text, toast) =>
    void navigator.clipboard?.writeText(text).then(
      () => Message.success(toast),
      (): undefined => undefined
    );
};

const TeamCollabBar: React.FC<TeamCollabBarProps> = ({ rootPath, collab, cloud }) => {
  const hasFolder = Boolean(rootPath);
  const { t } = useTranslation();
  const copy = useCopy();
  const [modal, setModal] = useState<null | 'publish' | 'join' | 'cloud'>(null);

  // Publish form.
  const [password, setPassword] = useState('123456');
  const [online, setOnline] = useState(false);
  const [allowWrites, setAllowWrites] = useState(true);
  const [allowDatabase, setAllowDatabase] = useState(false);
  // Join form.
  const [joinUrl, setJoinUrl] = useState('');
  const [joinPassword, setJoinPassword] = useState('123456');
  const [joinName, setJoinName] = useState('');
  // Cloud form.
  const [relayBaseUrl, setRelayBaseUrl] = useState(DEFAULT_CLOUD_RELAY_URL);
  const [workspaceId, setWorkspaceId] = useState('');
  const [cloudToken, setCloudToken] = useState('');
  const [displayName, setDisplayName] = useState('');

  const doPublish = async (): Promise<void> => {
    if (online && (password.trim().length < 6 || password === '123456')) {
      Message.warning(t('ide.teamCollab.weakPassword'));
      return;
    }
    const ok = await collab.publish(password, online, allowWrites, allowDatabase);
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

  const generateCloudCredentials = (): void => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    setWorkspaceId(crypto.randomUUID());
    setCloudToken([...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
  };

  const doCloudConnect = async (): Promise<void> => {
    if (workspaceId.trim().length < 16 || cloudToken.length < 32) {
      Message.warning(t('ide.cloudWorkspace.strongCredentialsRequired'));
      return;
    }
    const ok = await cloud.connect(
      relayBaseUrl,
      workspaceId,
      cloudToken,
      displayName || t('ide.team.you'),
      rootPath ?? undefined
    );
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
            {t('ide.teamCollab.joinedRepo', { repo: collab.peer.repoName })} ·{' '}
            {t(collab.peer.peerCapabilities.write ? 'ide.teamCollab.readWriteNote' : 'ide.teamCollab.fileReadOnlyNote')}
          </span>
        ) : cloud.connected && cloud.session ? (
          <span className='text-12px text-t-secondary truncate'>
            {t('ide.cloudWorkspace.connectedTitle', { workspace: cloud.session.workspaceId })} ·{' '}
            {cloud.state?.state ?? 'idle'}
          </span>
        ) : (
          <span className='text-12px text-t-tertiary'>{t('ide.teamCollab.idleHint')}</span>
        )}
      </div>

      {cloud.connected ? (
        <Button size='mini' status='danger' onClick={() => void cloud.disconnect()}>
          {t('ide.cloudWorkspace.disconnect')}
        </Button>
      ) : collab.role === 'none' ? (
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
          <Button
            size='mini'
            icon={<Cloudy theme='outline' size={13} />}
            loading={cloud.busy}
            onClick={() => {
              if (!workspaceId || !cloudToken) generateCloudCredentials();
              setModal('cloud');
            }}
          >
            {t('ide.cloudWorkspace.connect')}
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
          <div className='flex items-center justify-between gap-16px'>
            <span className='flex flex-col'>
              <span className='text-13px text-t-primary'>{t('ide.teamCollab.allowWrites')}</span>
              <span className='text-11px text-t-tertiary'>{t('ide.teamCollab.allowWritesHint')}</span>
            </span>
            <Switch checked={allowWrites} onChange={setAllowWrites} />
          </div>
          <div className='flex items-center justify-between gap-16px'>
            <span className='flex flex-col'>
              <span className='text-13px text-t-primary'>{t('ide.teamCollab.allowDatabase')}</span>
              <span className='text-11px text-t-tertiary'>{t('ide.teamCollab.allowDatabaseHint')}</span>
            </span>
            <Switch checked={allowDatabase} onChange={setAllowDatabase} />
          </div>
          {collab.error ? <span className='text-12px text-danger'>{collab.error}</span> : null}
        </div>
      </Modal>

      {/* Cloud modal */}
      <Modal
        title={t('ide.cloudWorkspace.connectTitle')}
        visible={modal === 'cloud'}
        onCancel={() => setModal(null)}
        onOk={() => void doCloudConnect()}
        confirmLoading={cloud.busy}
        okText={t('ide.cloudWorkspace.connect')}
        autoFocus={false}
      >
        <div className='flex flex-col gap-12px'>
          <label className='flex flex-col gap-4px'>
            <span className='text-12px text-t-secondary'>{t('ide.cloudWorkspace.relayUrl')}</span>
            <Input
              value={relayBaseUrl}
              onChange={setRelayBaseUrl}
              placeholder={t('ide.cloudWorkspace.relayUrlPlaceholder')}
            />
          </label>
          <label className='flex flex-col gap-4px'>
            <span className='text-12px text-t-secondary'>{t('ide.cloudWorkspace.workspaceId')}</span>
            <Input
              value={workspaceId}
              onChange={setWorkspaceId}
              placeholder={t('ide.cloudWorkspace.workspaceIdPlaceholder')}
            />
          </label>
          <label className='flex flex-col gap-4px'>
            <span className='text-12px text-t-secondary'>{t('ide.cloudWorkspace.token')}</span>
            <Input.Password
              value={cloudToken}
              onChange={setCloudToken}
              placeholder={t('ide.cloudWorkspace.tokenPlaceholder')}
            />
          </label>
          <div className='flex items-center justify-between gap-12px'>
            <span className='text-11px text-t-tertiary'>{t('ide.cloudWorkspace.securityHint')}</span>
            <Button size='mini' onClick={generateCloudCredentials}>
              {t('ide.cloudWorkspace.generateCredentials')}
            </Button>
          </div>
          <label className='flex flex-col gap-4px'>
            <span className='text-12px text-t-secondary'>{t('ide.cloudWorkspace.displayName')}</span>
            <Input
              value={displayName}
              onChange={setDisplayName}
              placeholder={t('ide.cloudWorkspace.displayNamePlaceholder')}
            />
          </label>
          {cloud.error ? <span className='text-12px text-danger'>{cloud.error}</span> : null}
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
