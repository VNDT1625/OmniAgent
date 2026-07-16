/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `CollabModal` — Publish or Join a real-time collaboration session (Canvas-like
 * co-editing over the LAN). The host publishes the open document and shares a
 * join code (`<ip>:<port>`) + password; peers join with that code.
 *
 * Two tabs:
 * - **Publish**: pick/confirm the password (default 123456) + display name,
 *   publish, then show the join code to copy. A LAN-only security note is shown.
 * - **Join**: enter the host's code + password + your name, then join — the
 *   parent opens a peer editor with the returned config.
 *
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { Alert, Button, Input, Message, Modal, Switch, Tabs, Tag, Typography } from '@arco-design/web-react';
import { Copy, Earth, Local, People, Refresh, Share } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ensureDocumentServer, getDocumentServerUrl } from '@renderer/pages/editor/adapters/onlyOfficeClient';
import {
  getCollabName,
  getCollabPassword,
  joinCollab,
  listDiscovered,
  publishCollab,
  setCollabName,
  setCollabPassword,
  startDiscovery,
  stopDiscovery,
  type CollabJoinData,
  type DiscoveredSession,
  type PublishInfo,
} from '@renderer/pages/editor/adapters/collabClient';

const { TabPane } = Tabs;

type CollabModalProps = {
  visible: boolean;
  /** Absolute path of the open file (host publishes this). */
  filePath: string;
  onClose: () => void;
  /** Host published successfully — surface the active share to the editor view. */
  onPublished: (info: PublishInfo) => void;
  /** Peer joined successfully — open a peer editor with this config + identity. */
  onJoined: (join: CollabJoinData, joinCode: string) => void;
  /** Default tab. */
  defaultTab?: 'publish' | 'join';
};

const CollabModal: React.FC<CollabModalProps> = ({ visible, filePath, onClose, onPublished, onJoined, defaultTab }) => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'publish' | 'join'>(defaultTab ?? 'publish');

  // Publish state
  const [password, setPassword] = useState(getCollabPassword());
  const [hostName, setHostName] = useState(getCollabName());
  const [online, setOnline] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<PublishInfo | null>(null);

  // Join state
  const [joinCode, setJoinCode] = useState('');
  const [joinPassword, setJoinPassword] = useState('123456');
  const [joinName, setJoinName] = useState(getCollabName());
  const [joining, setJoining] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredSession[]>([]);

  useEffect(() => {
    if (visible) {
      setTab(defaultTab ?? 'publish');
      setPublished(null);
    }
  }, [visible, defaultTab]);

  // While the Join tab is open, listen for LAN beacons and refresh the list.
  useEffect(() => {
    if (!visible || tab !== 'join') return;
    let alive = true;
    void startDiscovery();
    const poll = async (): Promise<void> => {
      const list = await listDiscovered();
      if (alive) setDiscovered(list);
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
      void stopDiscovery();
    };
  }, [visible, tab]);

  const handlePublish = async (): Promise<void> => {
    // Internet sharing exposes the doc publicly — require a non-default, decent password.
    if (online && (password.trim().length < 6 || password === '123456')) {
      Message.warning(t('studio.collab.weakPassword'));
      return;
    }
    setPublishing(true);
    try {
      setCollabPassword(password);
      setCollabName(hostName);
      // Ensure a Document Server is up; reuse its URL for peers.
      const resolved = await ensureDocumentServer(getDocumentServerUrl() || undefined);
      if (!resolved.ok) {
        Message.error(t('studio.collab.serverNeeded'));
        setPublishing(false);
        return;
      }
      const result = await publishCollab({
        path: filePath,
        documentServerUrl: resolved.url,
        password,
        hostName,
        advertisedHost: resolved.managed ? 'host.docker.internal' : undefined,
        online,
      });
      if (!result.ok) {
        Message.error((result as { error?: string }).error || t('studio.collab.publishFailed'));
        setPublishing(false);
        return;
      }
      setPublished(result.data);
      onPublished(result.data);
    } catch (cause) {
      Message.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPublishing(false);
    }
  };

  const handleJoin = async (): Promise<void> => {
    setJoining(true);
    try {
      setCollabName(joinName);
      const result = await joinCollab({ joinCode, password: joinPassword, name: joinName });
      if (!result.ok) {
        const failure = result as { error: string; code?: string };
        const msg =
          failure.code === 'bad-password'
            ? t('studio.collab.badPassword')
            : failure.code === 'unreachable'
              ? t('studio.collab.unreachable')
              : failure.error || t('studio.collab.joinFailed');
        Message.error(msg);
        setJoining(false);
        return;
      }
      onJoined(
        result.data,
        joinCode
          .trim()
          .replace(/^https?:\/\//, '')
          .replace(/\/+$/, '')
      );
      onClose();
    } catch (cause) {
      Message.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setJoining(false);
    }
  };

  const copyCode = (code: string): void => {
    void navigator.clipboard?.writeText(code).then(
      () => Message.success(t('studio.collab.copied')),
      (): void => undefined
    );
  };

  return (
    <Modal
      title={t('studio.collab.title')}
      visible={visible}
      onCancel={onClose}
      footer={null}
      unmountOnExit
      autoFocus={false}
    >
      <Tabs activeTab={tab} onChange={(key) => setTab(key as 'publish' | 'join')}>
        <TabPane
          key='publish'
          title={
            <span className='inline-flex items-center gap-6px'>
              <Share theme='outline' size='14' />
              {t('studio.collab.publishTab')}
            </span>
          }
        >
          <div className='flex flex-col gap-12px pt-8px'>
            <Alert type='warning' content={t('studio.collab.lanNote')} />
            {published === null ? (
              <>
                <Field label={t('studio.collab.yourName')}>
                  <Input value={hostName} onChange={setHostName} placeholder={t('studio.collab.namePlaceholder')} />
                </Field>
                <Field label={t('studio.collab.password')}>
                  <Input.Password value={password} onChange={setPassword} placeholder='123456' />
                </Field>
                <div className='flex items-center justify-between gap-8px px-2px'>
                  <span className='flex flex-col'>
                    <span className='text-13px text-t-primary font-[500] inline-flex items-center gap-6px'>
                      <Earth theme='outline' size='14' />
                      {t('studio.collab.onlineLabel')}
                    </span>
                    <span className='text-11px text-t-tertiary'>{t('studio.collab.onlineHint')}</span>
                  </span>
                  <Switch checked={online} onChange={setOnline} />
                </div>
                {online ? <Alert type='error' content={t('studio.collab.onlineWarn')} /> : null}
                <Button
                  type='primary'
                  long
                  loading={publishing}
                  icon={<Share theme='outline' size='15' />}
                  onClick={() => void handlePublish()}
                >
                  {online ? t('studio.collab.publishOnlineAction') : t('studio.collab.publishAction')}
                </Button>
              </>
            ) : (
              <div className='flex flex-col gap-10px'>
                <Tag color='green' icon={<People theme='outline' size='13' />} className='self-start'>
                  {t('studio.collab.live')}
                </Tag>
                <Field label={t('studio.collab.joinCode')}>
                  <div className='flex items-center gap-8px'>
                    <Input readOnly value={published.joinCode} className='font-mono' />
                    <Button icon={<Copy theme='outline' size='14' />} onClick={() => copyCode(published.joinCode)}>
                      {t('studio.collab.copy')}
                    </Button>
                  </div>
                </Field>
                <Field label={t('studio.collab.password')}>
                  <Input readOnly value={password} className='font-mono' />
                </Field>
                {published.lanIps.length > 1 ? (
                  <Typography.Text type='secondary' className='text-12px'>
                    {t('studio.collab.altIps')}: {published.lanIps.slice(1).join(', ')}
                  </Typography.Text>
                ) : null}
                <Typography.Text type='secondary' className='text-12px'>
                  <Local theme='outline' size='12' /> {t('studio.collab.shareHint')}
                </Typography.Text>
              </div>
            )}
          </div>
        </TabPane>

        <TabPane
          key='join'
          title={
            <span className='inline-flex items-center gap-6px'>
              <People theme='outline' size='14' />
              {t('studio.collab.joinTab')}
            </span>
          }
        >
          <div className='flex flex-col gap-12px pt-8px'>
            <div className='flex flex-col gap-6px'>
              <span className='text-12px text-t-secondary font-[500] inline-flex items-center gap-6px'>
                <Refresh theme='outline' size='12' />
                {t('studio.collab.discovered')}
              </span>
              {discovered.length === 0 ? (
                <div className='text-12px text-t-tertiary px-10px py-12px rd-8px bg-fill-1 text-center'>
                  {t('studio.collab.scanning')}
                </div>
              ) : (
                <div className='flex flex-col gap-4px max-h-160px overflow-y-auto'>
                  {discovered.map((s) => (
                    <button
                      key={s.shareId}
                      type='button'
                      onClick={() => setJoinCode(s.joinCode)}
                      className={`text-left px-10px py-8px rd-8px border border-solid transition-colors cursor-pointer ${joinCode === s.joinCode ? 'border-primary bg-primary-light-1' : 'border-line-2 bg-fill-1 hover:bg-fill-2'}`}
                    >
                      <div className='flex items-center justify-between gap-8px'>
                        <span className='text-13px font-[500] text-t-primary truncate'>{s.title || s.joinCode}</span>
                        <span className='text-11px text-t-tertiary font-mono shrink-0'>{s.joinCode}</span>
                      </div>
                      {s.hostName ? (
                        <span className='text-11px text-t-secondary'>
                          {t('studio.collab.hostedBy', { name: s.hostName })}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Field label={t('studio.collab.yourName')}>
              <Input value={joinName} onChange={setJoinName} placeholder={t('studio.collab.namePlaceholder')} />
            </Field>
            <Field label={t('studio.collab.joinCode')}>
              <Input value={joinCode} onChange={setJoinCode} placeholder='192.168.1.10:5xxxx' className='font-mono' />
            </Field>
            <Field label={t('studio.collab.password')}>
              <Input.Password value={joinPassword} onChange={setJoinPassword} placeholder='123456' />
            </Field>
            <Button
              type='primary'
              long
              loading={joining}
              disabled={joinCode.trim().length === 0}
              icon={<People theme='outline' size='15' />}
              onClick={() => void handleJoin()}
            >
              {t('studio.collab.joinAction')}
            </Button>
          </div>
        </TabPane>
      </Tabs>
    </Modal>
  );
};

/** A small labelled form row. */
const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className='flex flex-col gap-4px'>
    <span className='text-12px text-t-secondary font-[500]'>{label}</span>
    {children}
  </label>
);

export default CollabModal;
