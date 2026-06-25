/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `DbConnectionModal` — add / edit a database connection. Engine-aware form:
 * SQLite asks for a file path; Postgres/MySQL ask for host/port/db/user/pass.
 * A "Test" button validates the config before saving.
 *
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { Button, Input, InputNumber, Message, Modal, Select, Switch } from '@arco-design/web-react';
import { CheckOne, CloseOne, FolderOpen, LinkOne } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseDbUrl } from '@process/ide/db/dbUrl';
import { ipcBridge } from '@/common';
import type { DbConnectionConfig } from './dbClient';

type DbConnectionModalProps = {
  visible: boolean;
  /** When editing, the connection to seed the form (without password). */
  initial?: DbConnectionConfig | null;
  onClose: () => void;
  onSave: (config: DbConnectionConfig) => Promise<boolean>;
  onTest: (config: DbConnectionConfig) => Promise<{ ok: boolean; error?: string }>;
};

const newId = (): string => `db-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const DbConnectionModal: React.FC<DbConnectionModalProps> = ({ visible, initial, onClose, onSave, onTest }) => {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<DbConnectionConfig['kind']>(initial?.kind ?? 'sqlite');
  const [file, setFile] = useState(initial?.file ?? '');
  const [host, setHost] = useState(initial?.host ?? '127.0.0.1');
  const [port, setPort] = useState<number>(initial?.port ?? 5432);
  const [database, setDatabase] = useState(initial?.database ?? '');
  const [user, setUser] = useState(initial?.user ?? '');
  const [password, setPassword] = useState('');
  const [ssl, setSsl] = useState<boolean>(initial?.ssl ?? false);
  const [readOnly, setReadOnly] = useState<boolean>(initial?.readOnly !== false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const build = (): DbConnectionConfig => ({
    id: initial?.id ?? newId(),
    name: name.trim() || t('ide.db.untitled'),
    kind,
    file: kind === 'sqlite' ? file.trim() : undefined,
    host: kind !== 'sqlite' ? host.trim() : undefined,
    port: kind !== 'sqlite' ? port : undefined,
    database: kind !== 'sqlite' ? database.trim() : undefined,
    user: kind !== 'sqlite' ? user.trim() : undefined,
    password: kind !== 'sqlite' && password ? password : undefined,
    ssl: kind !== 'sqlite' ? ssl : undefined,
    readOnly,
    rootPath: initial?.rootPath,
  });

  const handlePickFile = async (): Promise<void> => {
    const picked = await ipcBridge.dialog.showOpen.invoke({ properties: ['openFile'] }).catch((): null => null);
    if (picked && picked.length > 0) setFile(picked[0]);
  };

  const handleTest = async (): Promise<void> => {
    setTesting(true);
    const res = await onTest(build());
    setTesting(false);
    if (res.ok) Message.success(t('ide.db.testOk'));
    else Message.error(res.error || t('ide.db.testFailed'));
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    const ok = await onSave(build());
    setSaving(false);
    if (ok) onClose();
  };

  const isNative = kind !== 'sqlite';

  /** Parse a pasted connection URL / DSN and fill the form fields. */
  const handleUrl = (raw: string): void => {
    const parsed = parseDbUrl(raw);
    if (!parsed) {
      if (raw.trim().length > 0) Message.warning(t('ide.db.urlInvalid'));
      return;
    }
    if (parsed.kind) setKind(parsed.kind);
    if (parsed.file !== undefined) setFile(parsed.file);
    if (parsed.host !== undefined) setHost(parsed.host);
    if (parsed.port !== undefined) setPort(parsed.port);
    if (parsed.database !== undefined) setDatabase(parsed.database);
    if (parsed.user !== undefined) setUser(parsed.user);
    if (parsed.password !== undefined) setPassword(parsed.password);
    if (parsed.ssl !== undefined) setSsl(parsed.ssl);
    Message.success(t('ide.db.urlFilled'));
  };

  return (
    <Modal
      title={initial ? t('ide.db.editConnection') : t('ide.db.addConnection')}
      visible={visible}
      onCancel={onClose}
      footer={
        <div className='flex items-center justify-between'>
          <Button type='outline' loading={testing} icon={<CheckOne theme='outline' size={14} />} onClick={handleTest}>
            {t('ide.db.test')}
          </Button>
          <div className='flex items-center gap-8px'>
            <Button onClick={onClose}>{t('ide.db.cancel')}</Button>
            <Button type='primary' loading={saving} onClick={handleSave}>
              {t('ide.db.save')}
            </Button>
          </div>
        </div>
      }
    >
      <div className='flex flex-col gap-12px'>
        <Field label={t('ide.db.pasteUrl')}>
          <Input
            allowClear
            placeholder={t('ide.db.pasteUrlPlaceholder')}
            prefix={<LinkOne theme='outline' size={14} className='text-t-tertiary' />}
            onChange={(v) => {
              if (v && /:\/\//.test(v)) handleUrl(v);
            }}
            onPressEnter={(e) => handleUrl((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label={t('ide.db.name')}>
          <Input value={name} onChange={setName} placeholder={t('ide.db.namePlaceholder')} />
        </Field>
        <Field label={t('ide.db.engine')}>
          <Select
            value={kind}
            onChange={(v) => setKind(v as DbConnectionConfig['kind'])}
            getPopupContainer={() => document.body}
          >
            <Select.Option value='sqlite'>SQLite</Select.Option>
            <Select.Option value='postgres'>PostgreSQL</Select.Option>
            <Select.Option value='mysql'>MySQL / MariaDB</Select.Option>
          </Select>
        </Field>

        {kind === 'sqlite' ? (
          <Field label={t('ide.db.file')}>
            <Input
              value={file}
              onChange={setFile}
              placeholder={t('ide.db.filePlaceholder')}
              suffix={
                <FolderOpen
                  theme='outline'
                  size={15}
                  className='cursor-pointer text-t-tertiary hover:text-primary'
                  onClick={handlePickFile}
                />
              }
            />
          </Field>
        ) : null}

        {isNative ? (
          <>
            <div className='flex gap-10px'>
              <Field label={t('ide.db.host')} className='flex-1'>
                <Input value={host} onChange={setHost} placeholder='127.0.0.1' />
              </Field>
              <Field label={t('ide.db.port')} className='w-110px'>
                <InputNumber value={port} onChange={(v) => setPort(Number(v) || 0)} min={1} max={65535} />
              </Field>
            </div>
            <Field label={t('ide.db.database')}>
              <Input value={database} onChange={setDatabase} placeholder={t('ide.db.databasePlaceholder')} />
            </Field>
            <div className='flex gap-10px'>
              <Field label={t('ide.db.user')} className='flex-1'>
                <Input value={user} onChange={setUser} />
              </Field>
              <Field label={t('ide.db.password')} className='flex-1'>
                <Input.Password
                  value={password}
                  onChange={setPassword}
                  placeholder={initial ? t('ide.db.passwordKept') : ''}
                />
              </Field>
            </div>
            <div className='flex items-center gap-8px'>
              <Switch size='small' checked={ssl} onChange={setSsl} />
              <span className='text-12px text-t-secondary'>{t('ide.db.ssl')}</span>
            </div>
          </>
        ) : null}

        <div className='flex items-center gap-8px pt-2px'>
          <Switch size='small' checked={readOnly} onChange={setReadOnly} />
          <span className='flex items-center gap-5px text-12px text-t-secondary'>
            {readOnly ? (
              <CheckOne theme='outline' size={13} className='text-success' />
            ) : (
              <CloseOne theme='outline' size={13} className='text-warning' />
            )}
            {t('ide.db.readOnly')}
          </span>
        </div>
        <span className='text-11px text-t-tertiary leading-snug'>{t('ide.db.readOnlyHint')}</span>
      </div>
    </Modal>
  );
};

/** A labelled form field. */
const Field: React.FC<{ label: string; className?: string; children: React.ReactNode }> = ({
  label,
  className,
  children,
}) => (
  <label className={`flex flex-col gap-4px ${className ?? ''}`}>
    <span className='text-12px font-500 text-t-secondary'>{label}</span>
    {children}
  </label>
);

export default DbConnectionModal;
