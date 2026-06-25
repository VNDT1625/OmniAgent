/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `CredentialManager` — a modal for managing the Automation credential vault.
 * Lists stored credentials and lets the user add one (name + kind + secret
 * fields). Secret values are write-only: once saved they are encrypted in the
 * Main process and never read back into the renderer.
 *
 * Renderer-only; all text via i18n; Arco + icon-park + UnoCSS tokens only.
 */

import { Button, Empty, Input, List, Modal, Select } from '@arco-design/web-react';
import { Delete, Plus } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCredentials } from '../useCredentials';
import type { CredentialSummary } from '../credentialClient';

const { Password } = Input;

type CredentialKind = 'token' | 'smtp' | 's3' | 'webdav' | 'generic';

/** Suggested field keys per credential kind (the user can add more). */
const FIELD_TEMPLATES: Record<CredentialKind, string[]> = {
  token: ['accessToken'],
  smtp: ['host', 'port', 'username', 'password', 'from'],
  s3: ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'],
  webdav: ['baseUrl', 'username', 'password'],
  generic: ['value'],
};

type CredentialManagerProps = {
  /** Close the modal. */
  onClose: () => void;
};

const CredentialManager: React.FC<CredentialManagerProps> = ({ onClose }) => {
  const { t } = useTranslation();
  const vault = useCredentials();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CredentialKind>('token');
  const [fields, setFields] = useState<Record<string, string>>({ accessToken: '' });

  const resetForm = (): void => {
    setName('');
    setKind('token');
    setFields({ accessToken: '' });
    setAdding(false);
  };

  const onKindChange = (next: CredentialKind): void => {
    setKind(next);
    const template = FIELD_TEMPLATES[next];
    const blank: Record<string, string> = {};
    for (const key of template) blank[key] = '';
    setFields(blank);
  };

  const handleSave = async (): Promise<void> => {
    if (name.trim().length === 0) return;
    const ok = await vault.save({ name: name.trim(), kind, fields });
    if (ok) resetForm();
  };

  return (
    <Modal title={t('automation.cred.title')} visible onCancel={onClose} footer={null} style={{ width: 560 }}>
      <div className='flex flex-col gap-12px'>
        {/* Existing credentials */}
        {vault.loading ? (
          <p className='m-0 text-13px text-t-tertiary'>{t('automation.cred.loading')}</p>
        ) : vault.credentials.length === 0 ? (
          <Empty description={t('automation.cred.empty')} />
        ) : (
          <List
            size='small'
            dataSource={vault.credentials}
            render={(item: CredentialSummary) => (
              <List.Item
                key={item.id}
                actions={[
                  <Button
                    key='del'
                    type='text'
                    size='mini'
                    status='danger'
                    icon={<Delete theme='outline' size={13} />}
                    onClick={() => void vault.remove(item.id)}
                    aria-label={t('automation.cred.remove')}
                  />,
                ]}
              >
                <span className='text-13px text-t-primary font-[500]'>{item.name}</span>
                <span className='text-11px text-t-tertiary ml-8px'>
                  {item.kind} · {item.fieldKeys.join(', ')}
                </span>
              </List.Item>
            )}
          />
        )}

        {vault.error ? <p className='m-0 text-12px text-danger'>{vault.error}</p> : null}

        {/* Add form */}
        {adding ? (
          <div className='flex flex-col gap-8px border-t border-b-1 pt-12px'>
            <Input value={name} onChange={setName} placeholder={t('automation.cred.namePlaceholder')} size='small' />
            <Select value={kind} onChange={(v) => onKindChange(v)} size='small'>
              <Select.Option value='token'>{t('automation.cred.kindToken')}</Select.Option>
              <Select.Option value='smtp'>{t('automation.cred.kindSmtp')}</Select.Option>
              <Select.Option value='s3'>{t('automation.cred.kindS3')}</Select.Option>
              <Select.Option value='webdav'>{t('automation.cred.kindWebdav')}</Select.Option>
              <Select.Option value='generic'>{t('automation.cred.kindGeneric')}</Select.Option>
            </Select>
            {Object.keys(fields).map((key) => (
              <label key={key} className='flex flex-col gap-2px'>
                <span className='text-11px text-t-secondary'>{key}</span>
                <Password
                  value={fields[key]}
                  onChange={(v) => setFields((prev) => ({ ...prev, [key]: v }))}
                  size='small'
                />
              </label>
            ))}
            <div className='flex items-center gap-8px'>
              <Button type='text' size='mini' onClick={resetForm}>
                {t('automation.cred.cancel')}
              </Button>
              <div className='flex-1' />
              <Button type='primary' size='small' disabled={name.trim().length === 0} onClick={() => void handleSave()}>
                {t('automation.cred.save')}
              </Button>
            </div>
          </div>
        ) : (
          <Button type='outline' size='small' icon={<Plus theme='outline' size={14} />} onClick={() => setAdding(true)}>
            {t('automation.cred.add')}
          </Button>
        )}
      </div>
    </Modal>
  );
};

export default CredentialManager;
