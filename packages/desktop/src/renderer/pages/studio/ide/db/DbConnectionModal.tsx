/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `DbConnectionModal` — add / edit a database connection. Engine-aware form that
 * spans local engines (SQLite), self-hosted/managed SQL (Postgres, MySQL incl.
 * Supabase / Neon / PlanetScale / RDS presets) and **cloud HTTP** engines
 * (Cloudflare D1, Firebase Firestore). A "Test" button validates the config
 * before saving; a paste-a-URL box autofills the SQL forms.
 *
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 *
 * Engine + Provider pickers are `Radio.Group type='button'` (inline segmented
 * buttons), NOT a `Select` dropdown. A popup-based Select kept fighting Arco's
 * modal focus-lock (the popup portals to `document.body`, the focus trap yanks
 * focus back on every re-render, and the dropdown flickered / refused to open).
 * Both pickers have only a handful of options, so inline buttons are clearer AND
 * have zero popup/focus/ResizeObserver surface — the bug class is gone for good.
 */

import { Button, Input, InputNumber, Message, Modal, Radio, Switch } from '@arco-design/web-react';
import { CheckOne, CloseOne, FolderOpen, LinkOne } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseDbUrl } from '@process/ide/db/dbUrl';
import { applyProviderPreset, type DbProvider } from '@process/ide/db/dbProviders';
import { ipcBridge } from '@/common';
import type { DbConnectionConfig } from './dbClient';
import FieldHelp from './FieldHelp';
import { DB_HELP_LINKS, sqlConnectionHelpUrl } from './dbHelpLinks';

type DbKind = DbConnectionConfig['kind'];

type DbConnectionModalProps = {
  visible: boolean;
  /** When editing, the connection to seed the form (without password). */
  initial?: DbConnectionConfig | null;
  onClose: () => void;
  onSave: (config: DbConnectionConfig) => Promise<boolean>;
  onTest: (config: DbConnectionConfig) => Promise<{ ok: boolean; error?: string }>;
};

const newId = (): string => `db-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Default port for a SQL engine when switching the engine select. */
const defaultPort = (kind: DbKind): number => (kind === 'mysql' ? 3306 : 5432);

const DbConnectionModal: React.FC<DbConnectionModalProps> = ({ visible, initial, onClose, onSave, onTest }) => {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<DbKind>(initial?.kind ?? 'sqlite');
  const [provider, setProvider] = useState<DbProvider | undefined>(initial?.provider);
  const [file, setFile] = useState(initial?.file ?? '');
  const [host, setHost] = useState(initial?.host ?? '127.0.0.1');
  const [port, setPort] = useState<number>(initial?.port ?? 5432);
  const [database, setDatabase] = useState(initial?.database ?? '');
  const [user, setUser] = useState(initial?.user ?? '');
  const [password, setPassword] = useState('');
  const [ssl, setSsl] = useState<boolean>(initial?.ssl ?? false);
  const [readOnly, setReadOnly] = useState<boolean>(initial?.readOnly !== false);
  // Cloud HTTP engine fields.
  const [accountId, setAccountId] = useState(initial?.accountId ?? '');
  const [databaseId, setDatabaseId] = useState(initial?.databaseId ?? '');
  const [projectId, setProjectId] = useState(initial?.projectId ?? '');
  const [apiToken, setApiToken] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const isSqlite = kind === 'sqlite';
  const isNative = kind === 'postgres' || kind === 'mysql';
  const isD1 = kind === 'd1';
  const isFirestore = kind === 'firestore';
  const isCloud = isD1 || isFirestore;

  // The dashboard / docs page where the SQL connection details live (provider
  // page when a managed provider is picked, otherwise the engine's docs).
  const sqlHelpUrl = sqlConnectionHelpUrl(kind, provider);

  const build = (): DbConnectionConfig => ({
    id: initial?.id ?? newId(),
    name: name.trim() || t('ide.db.untitled'),
    kind,
    provider: isNative ? provider : undefined,
    file: isSqlite ? file.trim() : undefined,
    host: isNative ? host.trim() : undefined,
    port: isNative ? port : undefined,
    database: isNative ? database.trim() : undefined,
    user: isNative ? user.trim() : undefined,
    password: isNative && password ? password : undefined,
    ssl: isNative ? ssl : undefined,
    accountId: isD1 ? accountId.trim() : undefined,
    databaseId: isD1 ? databaseId.trim() : undefined,
    projectId: isFirestore ? projectId.trim() : undefined,
    apiToken: isCloud && apiToken ? apiToken : undefined,
    readOnly: isFirestore ? true : readOnly,
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

  /** Switch engine, resetting the port to the engine default for SQL engines. */
  const handleKind = (next: DbKind): void => {
    setKind(next);
    if (next === 'postgres' || next === 'mysql') setPort((p) => (p === defaultPort(kind) ? defaultPort(next) : p));
    if (next !== 'postgres' && next !== 'mysql') setProvider(undefined);
  };

  /** Apply a managed-provider preset (host shape, SSL, port) onto the form. */
  const handleProvider = (next: DbProvider): void => {
    setProvider(next);
    const preset = applyProviderPreset(next, { host, port, ssl });
    if (preset.kind) setKind(preset.kind);
    if (preset.host !== undefined) setHost(preset.host);
    if (preset.port !== undefined) setPort(preset.port);
    if (preset.ssl !== undefined) setSsl(preset.ssl);
  };

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
    if (parsed.provider !== undefined) setProvider(parsed.provider);
    Message.success(t('ide.db.urlFilled'));
  };

  return (
    <Modal
      title={initial ? t('ide.db.editConnection') : t('ide.db.addConnection')}
      visible={visible}
      onCancel={onClose}
      autoFocus={false}
      focusLock={false}
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
        {!isCloud ? (
          <Field label={t('ide.db.pasteUrl')} help={<FieldHelp tooltip={t('ide.db.help.pasteUrl')} url={sqlHelpUrl} />}>
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
        ) : null}
        <Field label={t('ide.db.name')}>
          <Input value={name} onChange={setName} placeholder={t('ide.db.namePlaceholder')} />
        </Field>
        <Field label={t('ide.db.engine')}>
          <Radio.Group
            type='button'
            value={kind}
            onChange={(v) => handleKind(v as DbKind)}
            className='flex flex-wrap gap-4px'
          >
            <Radio value='sqlite'>SQLite</Radio>
            <Radio value='postgres'>PostgreSQL</Radio>
            <Radio value='mysql'>MySQL / MariaDB</Radio>
            <Radio value='d1'>Cloudflare D1</Radio>
            <Radio value='firestore'>Firebase Firestore</Radio>
          </Radio.Group>
        </Field>

        {isNative ? (
          <Field label={t('ide.db.provider')} help={<FieldHelp tooltip={t('ide.db.help.provider')} />}>
            <Radio.Group
              type='button'
              value={provider ?? 'custom'}
              onChange={(v) => (v === 'custom' ? setProvider(undefined) : handleProvider(v as DbProvider))}
              className='flex flex-wrap gap-4px'
            >
              <Radio value='custom'>{t('ide.db.providerCustom')}</Radio>
              <Radio value='supabase'>Supabase</Radio>
              <Radio value='neon'>Neon</Radio>
              <Radio value='planetscale'>PlanetScale</Radio>
              <Radio value='rds'>Amazon RDS</Radio>
            </Radio.Group>
          </Field>
        ) : null}

        {isSqlite ? (
          <Field label={t('ide.db.file')} help={<FieldHelp tooltip={t('ide.db.help.file')} />}>
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
              <Field
                label={t('ide.db.host')}
                className='flex-1'
                help={<FieldHelp tooltip={t('ide.db.help.host')} url={sqlHelpUrl} />}
              >
                <Input value={host} onChange={setHost} placeholder='127.0.0.1' />
              </Field>
              <Field
                label={t('ide.db.port')}
                className='w-110px'
                help={<FieldHelp tooltip={t('ide.db.help.port')} url={sqlHelpUrl} />}
              >
                <InputNumber value={port} onChange={(v) => setPort(Number(v) || 0)} min={1} max={65535} />
              </Field>
            </div>
            <Field
              label={t('ide.db.database')}
              help={<FieldHelp tooltip={t('ide.db.help.database')} url={sqlHelpUrl} />}
            >
              <Input value={database} onChange={setDatabase} placeholder={t('ide.db.databasePlaceholder')} />
            </Field>
            <div className='flex gap-10px'>
              <Field
                label={t('ide.db.user')}
                className='flex-1'
                help={<FieldHelp tooltip={t('ide.db.help.user')} url={sqlHelpUrl} />}
              >
                <Input value={user} onChange={setUser} />
              </Field>
              <Field
                label={t('ide.db.password')}
                className='flex-1'
                help={<FieldHelp tooltip={t('ide.db.help.password')} url={sqlHelpUrl} />}
              >
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

        {isD1 ? (
          <>
            <Field
              label={t('ide.db.accountId')}
              help={<FieldHelp tooltip={t('ide.db.help.accountId')} url={DB_HELP_LINKS.d1AccountId} />}
            >
              <Input value={accountId} onChange={setAccountId} placeholder={t('ide.db.accountIdPlaceholder')} />
            </Field>
            <Field
              label={t('ide.db.databaseId')}
              help={<FieldHelp tooltip={t('ide.db.help.databaseId')} url={DB_HELP_LINKS.d1DatabaseId} />}
            >
              <Input value={databaseId} onChange={setDatabaseId} placeholder={t('ide.db.databaseIdPlaceholder')} />
            </Field>
            <Field
              label={t('ide.db.apiToken')}
              help={<FieldHelp tooltip={t('ide.db.help.apiToken')} url={DB_HELP_LINKS.d1Token} />}
            >
              <Input.Password
                value={apiToken}
                onChange={setApiToken}
                placeholder={initial ? t('ide.db.passwordKept') : t('ide.db.apiTokenPlaceholder')}
              />
            </Field>
          </>
        ) : null}

        {isFirestore ? (
          <>
            <Field
              label={t('ide.db.projectId')}
              help={<FieldHelp tooltip={t('ide.db.help.projectId')} url={DB_HELP_LINKS.firestoreProject} />}
            >
              <Input value={projectId} onChange={setProjectId} placeholder={t('ide.db.projectIdPlaceholder')} />
            </Field>
            <Field
              label={t('ide.db.accessToken')}
              help={<FieldHelp tooltip={t('ide.db.help.accessToken')} url={DB_HELP_LINKS.firestoreToken} />}
            >
              <Input.Password
                value={apiToken}
                onChange={setApiToken}
                placeholder={initial ? t('ide.db.passwordKept') : t('ide.db.accessTokenPlaceholder')}
              />
            </Field>
            <span className='text-11px text-t-tertiary leading-snug'>{t('ide.db.firestoreHint')}</span>
          </>
        ) : null}

        {!isFirestore ? (
          <>
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
          </>
        ) : null}
      </div>
    </Modal>
  );
};

/** A labelled form field, with an optional inline help affordance by the label. */
const Field: React.FC<{ label: string; className?: string; help?: React.ReactNode; children: React.ReactNode }> = ({
  label,
  className,
  help,
  children,
}) => (
  <label className={`flex flex-col gap-4px ${className ?? ''}`}>
    <span className='flex items-center gap-4px text-12px font-500 text-t-secondary'>
      {label}
      {help}
    </span>
    {children}
  </label>
);

export default DbConnectionModal;
