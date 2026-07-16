/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `SpreadsheetAdapter` — view + edit spreadsheets (Yêu cầu 2a, criterion 2.3).
 *
 * Office is the ONLY editing experience the user picks: full WYSIWYG editing via
 * the ONLYOFFICE Document Server (auto-started on demand). The manual "Edit
 * (Office) / Edit" switch was removed — Office is always tried first. If the
 * Office editor cannot open (Docker missing, server unreachable, runtime error),
 * the adapter AUTOMATICALLY falls back to a lightweight editable grid (loaded/
 * saved as CSV via the Main-process Office bridge) so the file stays editable.
 * A slim notice then offers to retry Office or configure the Document Server.
 *
 * Renderer-only.
 */

import { Alert, Button, Result, Spin, Table } from '@arco-design/web-react';
import { FileExcel, Plus, Save } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EditorAdapterProps } from '../adapterRegistry';
import { readXlsxCsv, writeXlsxCsv } from './studioOfficeClient';
import OnlyOfficeEditor from './OnlyOfficeEditor';
import OnlyOfficeSettingsModal from './OnlyOfficeSettingsModal';
import OfficeFallbackNotice from './OfficeFallbackNotice';

/** Parse CSV-ish text into a matrix of cell strings. */
const parseRows = (text: string): string[][] => {
  if (text.trim() === '') return [['']];
  return text.split(/\r?\n/).map((line) => line.split(','));
};

/** Serialize a matrix back into CSV text. */
const serializeRows = (rows: string[][]): string => rows.map((r) => r.join(',')).join('\n');

/** First sheet as an editable grid (loaded/saved as CSV via the Office bridge). */
const EditView: React.FC<{ filePath: string; readOnly?: boolean }> = ({ filePath, readOnly }) => {
  const { t } = useTranslation();
  const [rows, setRows] = useState<string[][]>([['']]);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState<boolean>(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const csv = await readXlsxCsv(filePath);
      setRows(parseRows(csv));
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

  const columnCount = rows.reduce((max, r) => Math.max(max, r.length), 1);

  const updateCell = useCallback((rowIndex: number, colIndex: number, value: string) => {
    setRows((prev) => {
      const next = prev.map((r) => [...r]);
      while (next[rowIndex].length <= colIndex) next[rowIndex].push('');
      next[rowIndex][colIndex] = value;
      return next;
    });
    setDirty(true);
  }, []);

  const addRow = useCallback(() => {
    setRows((prev) => [...prev.map((r) => [...r]), Array.from({ length: columnCount }, () => '')]);
    setDirty(true);
  }, [columnCount]);

  const handleSave = useCallback(async () => {
    if (readOnly || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      await writeXlsxCsv(filePath, serializeRows(rows));
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [readOnly, dirty, rows, filePath]);

  const columns = useMemo(
    () =>
      Array.from({ length: columnCount }, (_unused, colIndex) => ({
        title: String.fromCharCode(65 + (colIndex % 26)),
        dataIndex: `c${colIndex}`,
        render: (_: unknown, _record: unknown, rowIndex: number) => (
          <input
            className='w-full bg-transparent border-none outline-none text-13px text-t-primary'
            value={rows[rowIndex]?.[colIndex] ?? ''}
            readOnly={readOnly}
            onChange={(e) => updateCell(rowIndex, colIndex, e.target.value)}
            aria-label={`cell-${rowIndex}-${colIndex}`}
          />
        ),
      })),
    [columnCount, rows, readOnly, updateCell]
  );

  const data = useMemo(() => rows.map((_r, i) => ({ key: i })), [rows]);

  if (loading) {
    return (
      <div className='flex-center flex-1'>
        <Spin tip={t('editor.state.loading')} />
      </div>
    );
  }

  if (error !== null) {
    return (
      <Result
        status='error'
        icon={<FileExcel theme='outline' size='32' />}
        title={t('editor.spreadsheet.openFailed')}
        subTitle={error}
        extra={
          <Button type='primary' onClick={() => void load()}>
            {t('editor.action.retry')}
          </Button>
        }
      />
    );
  }

  return (
    <div className='flex flex-col flex-1 min-h-0 gap-8px'>
      <div className='flex items-center justify-between gap-8px'>
        <Alert type='info' className='flex-1' content={t('editor.spreadsheet.editNotice')} />
        <div className='flex items-center gap-8px shrink-0'>
          <Button size='small' icon={<Plus theme='outline' size='14' />} disabled={readOnly} onClick={addRow}>
            {t('editor.spreadsheet.addRow')}
          </Button>
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
      </div>
      <div className='flex-1 min-h-0 overflow-auto border border-border-base rd-6px'>
        <Table columns={columns} data={data} pagination={false} border size='small' />
      </div>
    </div>
  );
};

/** Spreadsheet adapter: Office editing by default; auto-falls back to a grid. */
const SpreadsheetAdapter: React.FC<EditorAdapterProps> = ({ filePath, readOnly }) => {
  // Office is the default. `fallbackReason` is set when Office can't open, which
  // switches to the lightweight grid editor and shows a retry/settings notice.
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

export default SpreadsheetAdapter;
