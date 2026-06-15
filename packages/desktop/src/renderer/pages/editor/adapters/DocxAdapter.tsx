/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `DocxAdapter` — view + edit Word documents (Yêu cầu 2a, criterion 2.2).
 *
 * Office is the ONLY editing experience the user picks: full WYSIWYG editing via
 * the ONLYOFFICE Document Server (auto-started on demand). The manual "Edit
 * (Office) / Edit" switch was removed — Office is always tried first. If the
 * Office editor cannot open (Docker missing, server unreachable, runtime error),
 * the adapter AUTOMATICALLY falls back to a lightweight plain-text editor backed
 * by the Main-process docx bridge so the file stays editable. A slim notice then
 * offers to retry Office or configure the Document Server.
 *
 * Renderer-only.
 */

import { Alert, Button, Input, Spin } from '@arco-design/web-react';
import { Save } from '@icon-park/react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EditorAdapterProps } from '../adapterRegistry';
import { readDocxText, writeDocxText } from './studioDocxClient';
import OnlyOfficeEditor from './OnlyOfficeEditor';
import OnlyOfficeSettingsModal from './OnlyOfficeSettingsModal';
import OfficeFallbackNotice from './OfficeFallbackNotice';

/** Plain-text edit view backed by the Main-process docx bridge. */
const EditView: React.FC<{ filePath: string; readOnly?: boolean }> = ({ filePath, readOnly }) => {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setText(await readDocxText(filePath));
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [filePath]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = useCallback(async () => {
    if (readOnly || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      await writeDocxText(filePath, text);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [readOnly, dirty, text, filePath]);

  if (loading) {
    return (
      <div className='flex-center flex-1'>
        <Spin tip={t('editor.state.loading')} />
      </div>
    );
  }

  return (
    <div className='flex flex-col flex-1 min-h-0 gap-8px'>
      <div className='flex items-center justify-between gap-8px'>
        <Alert type='info' className='flex-1' content={t('editor.docx.editNotice')} />
        <Button
          type='primary'
          size='small'
          icon={<Save theme='outline' size='14' />}
          loading={saving}
          disabled={readOnly || !dirty}
          onClick={() => void handleSave()}
        >
          {t('editor.action.save')}
        </Button>
      </div>
      {error !== null ? <Alert type='error' content={error} /> : null}
      <Input.TextArea
        className='flex-1 min-h-0 text-14px leading-relaxed'
        value={text}
        readOnly={readOnly}
        onChange={(value) => {
          setText(value);
          setDirty(true);
        }}
        placeholder={t('editor.docx.placeholder')}
      />
    </div>
  );
};

/** Word adapter: Office editing by default; auto-falls back to plain text. */
const DocxAdapter: React.FC<EditorAdapterProps> = ({ filePath, readOnly }) => {
  // Office is the default. `fallbackReason` is set when Office can't open, which
  // switches to the lightweight text editor and shows a retry/settings notice.
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Bump to remount the Office editor when the user retries.
  const [officeKey, setOfficeKey] = useState(0);

  const retryOffice = useCallback(() => {
    setFallbackReason(null);
    setOfficeKey((k) => k + 1);
  }, []);

  if (fallbackReason === null) {
    return (
      <div className='flex flex-col h-full w-full'>
        <OnlyOfficeEditor key={officeKey} filePath={filePath} onFatalError={(reason) => setFallbackReason(reason)} />
      </div>
    );
  }

  return (
    <div className='flex flex-col h-full w-full gap-8px'>
      <OfficeFallbackNotice reason={fallbackReason} onRetry={retryOffice} onSettings={() => setSettingsOpen(true)} />
      <EditView filePath={filePath} readOnly={readOnly} />
      <OnlyOfficeSettingsModal visible={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={retryOffice} />
    </div>
  );
};

export default DocxAdapter;
