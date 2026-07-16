/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `RegisterRepoModal` — the "Register a repository" form: paste the remote URL,
 * pick (or type) the local folder, choose the branch + credential, and optionally
 * clone it down immediately. This is the entry point of the Git Manager — once a
 * repo is registered the user can push/pull/backup it from the detail pane.
 *
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { ipcBridge } from '@/common';
import { Button, Input, Modal, Select, Switch } from '@arco-design/web-react';
import { FolderOpen } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitCredential } from '@process/git/gitTypes';
import type { RegisterRepoRequest } from '@process/git/gitManagerBridge';

type RegisterRepoModalProps = {
  open: boolean;
  credentials: GitCredential[];
  busy: boolean;
  onClose: () => void;
  onManageCredentials: () => void;
  onSubmit: (req: RegisterRepoRequest) => Promise<void>;
};

/** Best-effort repo name from a remote URL (`.../owner/repo.git` → `repo`). */
const deriveName = (url: string): string => {
  const cleaned = url
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const last = cleaned.split(/[/:]/).pop();
  return last && last.length > 0 ? last : '';
};

const RegisterRepoModal: React.FC<RegisterRepoModalProps> = ({
  open,
  credentials,
  busy,
  onClose,
  onManageCredentials,
  onSubmit,
}) => {
  const { t } = useTranslation();
  const [remoteUrl, setRemoteUrl] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [branch, setBranch] = useState('main');
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [cloneNow, setCloneNow] = useState(true);

  const reset = (): void => {
    setRemoteUrl('');
    setLocalPath('');
    setBranch('main');
    setCredentialId(null);
    setCloneNow(true);
  };

  const pickFolder = async (): Promise<void> => {
    const dirs = await ipcBridge.dialog.showOpen
      .invoke({ properties: ['openDirectory'] })
      .catch((): undefined => undefined);
    if (dirs && dirs[0]) setLocalPath(dirs[0]);
  };

  const canSubmit = remoteUrl.trim().length > 0 && localPath.trim().length > 0;

  const submit = (): void => {
    if (!canSubmit) return;
    void onSubmit({
      remoteUrl: remoteUrl.trim(),
      localPath: localPath.trim(),
      branch: branch.trim() || 'main',
      name: deriveName(remoteUrl) || undefined,
      credentialId,
      cloneNow,
    }).then(reset);
  };

  return (
    <Modal
      visible={open}
      title={t('git.register.title')}
      onCancel={() => {
        reset();
        onClose();
      }}
      onOk={submit}
      okText={cloneNow ? t('git.register.addAndClone') : t('git.register.add')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      okButtonProps={{ disabled: !canSubmit }}
      style={{ width: 560 }}
    >
      <div className='flex flex-col gap-12px'>
        <Field label={t('git.register.remoteUrl')} hint={t('git.register.remoteUrlHint')}>
          <Input value={remoteUrl} onChange={setRemoteUrl} placeholder='https://github.com/owner/repo.git' />
        </Field>

        <Field label={t('git.register.localPath')} hint={t('git.register.localPathHint')}>
          <div className='flex items-center gap-6px'>
            <Input value={localPath} onChange={setLocalPath} placeholder='C:\\Projects\\repo' className='flex-1' />
            <Button icon={<FolderOpen theme='outline' size={14} />} onClick={() => void pickFolder()}>
              {t('git.register.browse')}
            </Button>
          </div>
        </Field>

        <div className='flex items-center gap-12px'>
          <Field label={t('git.register.branch')} className='flex-1'>
            <Input value={branch} onChange={setBranch} placeholder='main' />
          </Field>
          <Field label={t('git.register.credential')} className='flex-1'>
            <Select
              value={credentialId ?? undefined}
              onChange={(v) => setCredentialId((v as string) ?? null)}
              placeholder={t('git.register.credentialNone')}
              allowClear
              notFoundContent={
                <div className='p-8px text-center'>
                  <Button type='text' size='mini' onClick={onManageCredentials}>
                    {t('git.register.addCredential')}
                  </Button>
                </div>
              }
            >
              {credentials.map((c) => (
                <Select.Option key={c.id} value={c.id}>
                  {c.label} · ···{c.tokenHint}
                </Select.Option>
              ))}
            </Select>
          </Field>
        </div>

        <div className='flex items-center justify-between rd-8px bg-fill-1 px-12px py-8px'>
          <div className='flex flex-col'>
            <span className='text-13px text-t-primary'>{t('git.register.cloneNow')}</span>
            <span className='text-11px text-t-tertiary'>{t('git.register.cloneNowHint')}</span>
          </div>
          <Switch checked={cloneNow} onChange={setCloneNow} />
        </div>
      </div>
    </Modal>
  );
};

/** A labelled form field with an optional hint line. */
const Field: React.FC<{ label: string; hint?: string; className?: string; children: React.ReactNode }> = ({
  label,
  hint,
  className,
  children,
}) => (
  <div className={`flex flex-col gap-4px ${className ?? ''}`}>
    <span className='text-12px font-600 text-t-secondary'>{label}</span>
    {children}
    {hint ? <span className='text-11px text-t-tertiary'>{hint}</span> : null}
  </div>
);

export default RegisterRepoModal;
