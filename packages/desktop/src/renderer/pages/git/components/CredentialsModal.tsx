/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `CredentialsModal` — manage the stored Personal Access Tokens used to
 * authenticate push/pull/clone. Tokens are encrypted at rest in the Main process
 * (Electron `safeStorage`); this UI only ever shows a 4-char hint, never the
 * full token. Add a credential (label + host + username + token) or remove one.
 *
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { Button, Empty, Input, Modal, Popconfirm } from '@arco-design/web-react';
import { Delete, Key, Plus } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitCredential } from '@process/git/gitTypes';
import type { AddCredentialRequest } from '@process/git/gitManagerBridge';

type CredentialsModalProps = {
  open: boolean;
  credentials: GitCredential[];
  onClose: () => void;
  onAdd: (req: AddCredentialRequest) => Promise<boolean>;
  onRemove: (id: string) => Promise<void>;
};

const CredentialsModal: React.FC<CredentialsModalProps> = ({ open, credentials, onClose, onAdd, onRemove }) => {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('github.com');
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);

  const resetForm = (): void => {
    setLabel('');
    setHost('github.com');
    setUsername('');
    setToken('');
    setAdding(false);
  };

  const canSave = token.trim().length > 0 && host.trim().length > 0;

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    try {
      const ok = await onAdd({
        label: label.trim() || host.trim(),
        host: host.trim(),
        username: username.trim(),
        token: token.trim(),
      });
      if (ok) resetForm();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible={open}
      title={
        <span className='flex items-center gap-8px'>
          <Key theme='outline' size={16} className='text-primary' />
          {t('git.credentials.title')}
        </span>
      }
      onCancel={() => {
        resetForm();
        onClose();
      }}
      footer={null}
      style={{ width: 560 }}
    >
      <div className='flex flex-col gap-12px'>
        <p className='m-0 text-12px text-t-tertiary leading-relaxed'>{t('git.credentials.intro')}</p>

        {/* Existing credentials */}
        {credentials.length === 0 ? (
          <Empty description={t('git.credentials.empty')} />
        ) : (
          <div className='flex flex-col gap-6px'>
            {credentials.map((c) => (
              <div key={c.id} className='flex items-center gap-10px rd-8px border border-arco-2 px-12px py-8px'>
                <span className='size-30px shrink-0 flex-center rd-8px bg-fill-2 text-t-secondary'>
                  <Key theme='outline' size={14} />
                </span>
                <span className='flex flex-col min-w-0 flex-1'>
                  <span className='truncate text-13px font-600 text-t-primary'>{c.label}</span>
                  <span className='truncate text-11px text-t-tertiary'>
                    {c.host} · {c.username} · ···{c.tokenHint}
                  </span>
                </span>
                <Popconfirm
                  title={t('git.credentials.removeConfirm')}
                  okText={t('git.credentials.remove')}
                  cancelText={t('common.cancel')}
                  okButtonProps={{ status: 'danger' }}
                  onOk={() => void onRemove(c.id)}
                >
                  <Button type='text' size='small' status='danger' icon={<Delete theme='outline' size={14} />} />
                </Popconfirm>
              </div>
            ))}
          </div>
        )}

        {/* Add form */}
        {adding ? (
          <div className='flex flex-col gap-8px rd-8px bg-fill-1 p-12px'>
            <div className='flex items-center gap-8px'>
              <Input
                value={label}
                onChange={setLabel}
                placeholder={t('git.credentials.labelPlaceholder')}
                className='flex-1'
              />
              <Input value={host} onChange={setHost} placeholder='github.com' className='w-160px' />
            </div>
            <Input value={username} onChange={setUsername} placeholder={t('git.credentials.usernamePlaceholder')} />
            <Input.Password value={token} onChange={setToken} placeholder={t('git.credentials.tokenPlaceholder')} />
            <span className='text-11px text-t-tertiary'>{t('git.credentials.tokenHint')}</span>
            <div className='flex items-center gap-8px self-end'>
              <Button size='small' onClick={resetForm}>
                {t('common.cancel')}
              </Button>
              <Button type='primary' size='small' loading={saving} disabled={!canSave} onClick={() => void save()}>
                {t('git.credentials.save')}
              </Button>
            </div>
          </div>
        ) : (
          <Button type='outline' icon={<Plus theme='outline' size={14} />} onClick={() => setAdding(true)}>
            {t('git.credentials.add')}
          </Button>
        )}
      </div>
    </Modal>
  );
};

export default CredentialsModal;
