/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Import events from a prompt + mixed attachments (Requirement 6.4–6.6,
 * extended). The user can:
 *
 * - type an instruction/prompt,
 * - attach one or more files: images (timetable photos), PDF/DOCX/PPTX/XLSX,
 *   and text-like files (MD/JSON/CSV/TXT/…),
 *
 * then let the model build events from everything together. The user reviews +
 * edits the proposals before saving (nothing is written until "Save selected").
 *
 * Performance: images are **downscaled** in the renderer before being sent (a
 * raw phone photo would otherwise make the vision request crawl or fail). Binary
 * documents are extracted to text in the Main process by path (via
 * `electronAPI.getPathForFile`); text-like files are read inline.
 *
 * Errors are shown inline, including the "model has no vision" case (6.7).
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Checkbox, Input, Message, Modal, Progress, Tag } from '@arco-design/web-react';
import { Close, FileText, Pic, Plus } from '@icon-park/react';
import type { EventProposal } from '@process/manager/managerAi';
import type { UseManagerStore } from '../useManagerStore';
import { formatTimeRange } from './scheduleUtils';
import { classifyImportFile, downscaleImageToDataUrl, MAX_IMAGES, readTextFile } from './importFiles';

const { TextArea } = Input;

/** Phases of the analyze pipeline, surfaced in the progress bar. */
type AnalyzePhase = 'preparing' | 'extracting' | 'analyzing';

/** An attachment staged for import. */
type ImportItem = {
  id: string;
  name: string;
  kind: 'image' | 'text' | 'doc';
  /** Downscaled data URL (images only). */
  dataUrl?: string;
  /** Inline UTF-8 text (text-like files only). */
  text?: string;
  /** Absolute path for Main-process extraction (docs only). */
  path?: string;
  status: 'ready' | 'error';
};

let itemSeq = 0;

const ImportFromImage: React.FC<{ store: UseManagerStore; onClose: (savedCount: number) => void }> = ({
  store,
  onClose,
}) => {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState('');
  const [items, setItems] = useState<ImportItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<AnalyzePhase>('preparing');
  /** Smooth 0–100 progress that creeps toward a phase ceiling (AI time is unknown). */
  const [progress, setProgress] = useState(0);
  /** Seconds elapsed since analyze started (shown next to the bar). */
  const [elapsed, setElapsed] = useState(0);
  const [proposals, setProposals] = useState<EventProposal[]>([]);
  const [selected, setSelected] = useState<boolean[]>([]);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Ceiling the creeping progress approaches for the current phase. */
  const progressCeilingRef = useRef(20);

  // While analyzing, advance a timer + a creeping progress bar that eases toward
  // the current phase ceiling, so a long vision call still feels responsive.
  useEffect(() => {
    if (!loading) return;
    const startedAt = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
      setProgress((prev) => {
        const ceiling = progressCeilingRef.current;
        if (prev >= ceiling) return prev;
        // Ease toward the ceiling: bigger steps when far, smaller when close.
        return Math.min(ceiling, prev + Math.max(0.4, (ceiling - prev) * 0.08));
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [loading]);

  const imageCount = items.filter((it) => it.kind === 'image').length;

  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const next: ImportItem[] = [];
    for (const file of Array.from(files)) {
      const kind = classifyImportFile(file);
      const id = `it-${++itemSeq}`;
      if (kind === 'image') {
        if (imageCount + next.filter((n) => n.kind === 'image').length >= MAX_IMAGES) {
          Message.warning(t('manager.schedule.import.tooManyImages', { count: MAX_IMAGES }));
          continue;
        }
        try {
          const dataUrl = await downscaleImageToDataUrl(file);
          next.push({ id, name: file.name, kind: 'image', dataUrl, status: 'ready' });
        } catch {
          next.push({ id, name: file.name, kind: 'image', status: 'error' });
        }
      } else if (kind === 'text') {
        try {
          const text = await readTextFile(file);
          next.push({ id, name: file.name, kind: 'text', text, status: 'ready' });
        } catch {
          next.push({ id, name: file.name, kind: 'text', status: 'error' });
        }
      } else if (kind === 'doc') {
        // Binary doc: needs an absolute path so Main can extract it.
        const path = window.electronAPI?.getPathForFile?.(file);
        if (path) next.push({ id, name: file.name, kind: 'doc', path, status: 'ready' });
        else next.push({ id, name: file.name, kind: 'doc', status: 'error' });
      } else {
        Message.warning(t('manager.schedule.import.unsupportedFile', { name: file.name }));
      }
    }
    if (next.length > 0) setItems((prev) => [...prev, ...next]);
  };

  const removeItem = (id: string) => setItems((prev) => prev.filter((it) => it.id !== id));

  const setResults = (events: EventProposal[]) => {
    setProposals(events);
    setSelected(events.map(() => true));
  };

  const handleAnalyze = async () => {
    const ready = items.filter((it) => it.status === 'ready');
    const hasPrompt = prompt.trim().length > 0;
    if (!hasPrompt && ready.length === 0) {
      Message.warning(t('manager.schedule.import.needInput'));
      return;
    }
    setProgress(0);
    setPhase('preparing');
    progressCeilingRef.current = 15;
    setLoading(true);
    try {
      // 1) Extract binary docs (PDF/DOCX/…) to text in the Main process.
      const docPaths = ready.filter((it) => it.kind === 'doc' && it.path).map((it) => it.path!);
      const docs: Array<{ name: string; text: string }> = [];
      if (docPaths.length > 0) {
        setPhase('extracting');
        progressCeilingRef.current = 35;
        const ext = await store.client.extractFiles({ paths: docPaths });
        if (ext.ok) {
          for (const d of ext.data) if (d.text.trim().length > 0) docs.push({ name: d.name, text: d.text });
        }
      }
      // 2) Inline text files.
      for (const it of ready) {
        if (it.kind === 'text' && it.text && it.text.trim().length > 0) docs.push({ name: it.name, text: it.text });
      }
      // 3) Downscaled images.
      const images = ready.filter((it) => it.kind === 'image' && it.dataUrl).map((it) => it.dataUrl!);

      // 4) AI parse — the long step. Creep toward 95% while we wait.
      setPhase('analyzing');
      progressCeilingRef.current = 95;
      const result = await store.client.aiParseMulti({ prompt: prompt.trim() || undefined, docs, images });
      setProgress(100);
      handleResult(result);
    } catch {
      Message.error(t('manager.schedule.import.errorGeneric'));
    } finally {
      setLoading(false);
    }
  };

  const handleResult = (result: Awaited<ReturnType<typeof store.client.aiParseMulti>>) => {
    if (result.ok) {
      if (result.data.length === 0) {
        Message.info(t('manager.schedule.import.noneFound'));
        return;
      }
      setResults(result.data);
      return;
    }
    const code = (result as { code?: string }).code;
    if (code === 'no-model') {
      Message.warning(t('manager.schedule.import.errorNoModel'));
    } else if (code === 'no-vision') {
      Message.warning(t('manager.schedule.import.errorNoVision'));
    } else {
      Message.error(t('manager.schedule.import.errorGeneric'));
    }
  };

  const handleSave = async () => {
    const chosen = proposals.filter((_, i) => selected[i]);
    if (chosen.length === 0) {
      Message.warning(t('manager.schedule.import.selectAtLeastOne'));
      return;
    }
    const hadImage = items.some((it) => it.kind === 'image');
    setSaving(true);
    try {
      let saved = 0;
      for (const p of chosen) {
        const ok = await store.run(() =>
          store.client.addEvent({
            input: {
              title: p.title,
              startAt: p.startAt,
              endAt: p.endAt,
              lockKind: p.lockKind ?? 'flexible',
              location: p.location ?? null,
              note: p.note ?? null,
              source: hadImage ? 'image' : 'prompt',
            },
          })
        );
        if (ok) saved += 1;
      }
      Message.success(t('manager.schedule.import.savedCount', { count: saved }));
      onClose(saved);
    } finally {
      setSaving(false);
    }
  };

  const hasResults = proposals.length > 0;

  const kindIcon = (kind: ImportItem['kind']) =>
    kind === 'image' ? <Pic theme='outline' size='13' /> : <FileText theme='outline' size='13' />;

  return (
    <Modal
      visible
      title={t('manager.schedule.import.title')}
      onCancel={() => onClose(0)}
      footer={
        <div className='flex justify-end gap-8px'>
          <Button onClick={() => onClose(0)}>{t('manager.schedule.import.cancel')}</Button>
          {hasResults ? (
            <Button type='primary' loading={saving} onClick={() => void handleSave()}>
              {t('manager.schedule.import.saveSelected', { count: selected.filter(Boolean).length })}
            </Button>
          ) : (
            <Button type='primary' loading={loading} onClick={() => void handleAnalyze()}>
              {loading
                ? t('manager.schedule.import.analyzingBtn', { percent: Math.round(progress) })
                : t('manager.schedule.import.analyze')}
            </Button>
          )}
        </div>
      }
      style={{ width: 580 }}
    >
      {!hasResults ? (
        <div className='flex flex-col gap-12px'>
          {loading && (
            <div className='rd-10px border border-solid border-arco-2 bg-fill-1 p-14px flex flex-col gap-8px'>
              <div className='flex items-center justify-between'>
                <span className='text-13px font-[600] text-t-primary'>
                  {t(`manager.schedule.import.phase.${phase}`)}
                </span>
                <span className='text-12px text-t-tertiary'>
                  {t('manager.schedule.import.elapsed', { s: elapsed })}
                </span>
              </div>
              <Progress percent={Math.round(progress)} showText={false} animation />
              <span className='text-11px text-t-tertiary'>{t('manager.schedule.import.analyzingHint')}</span>
            </div>
          )}

          {/* Prompt */}
          <div>
            <div className='text-12px text-t-secondary mb-4px'>{t('manager.schedule.import.promptLabel')}</div>
            <TextArea
              value={prompt}
              onChange={setPrompt}
              disabled={loading}
              placeholder={t('manager.schedule.import.promptPlaceholder')}
              autoSize={{ minRows: 2, maxRows: 5 }}
            />
          </div>

          {/* Attachments */}
          <div>
            <div className='flex items-center justify-between mb-6px'>
              <div className='text-12px text-t-secondary'>{t('manager.schedule.import.filesLabel')}</div>
              <Button
                size='mini'
                disabled={loading}
                icon={<Plus theme='outline' size='12' />}
                onClick={() => fileInputRef.current?.click()}
              >
                {t('manager.schedule.import.addFiles')}
              </Button>
            </div>
            <input
              ref={fileInputRef}
              type='file'
              multiple
              accept='image/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.odp,.ods,.txt,.md,.markdown,.json,.csv,.tsv,.yaml,.yml,.log,.ics,.xml,.html,.htm,.rtf'
              className='hidden'
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            {items.length === 0 ? (
              <div
                className='rd-8px border border-dashed border-arco-3 text-center text-12px text-t-tertiary py-16px cursor-pointer hover:bg-fill-1'
                onClick={() => fileInputRef.current?.click()}
              >
                {t('manager.schedule.import.dropHint')}
              </div>
            ) : (
              <div className='flex flex-col gap-6px'>
                {items.map((it) => (
                  <div
                    key={it.id}
                    className='flex items-center gap-8px rd-8px border border-solid border-arco-2 px-10px py-6px'
                  >
                    <span className={it.status === 'error' ? 'text-danger' : 'text-t-tertiary'}>
                      {kindIcon(it.kind)}
                    </span>
                    <span className='flex-1 min-w-0 text-12px text-t-primary truncate'>{it.name}</span>
                    {it.status === 'error' && (
                      <span className='text-11px text-danger'>{t('manager.schedule.import.fileError')}</span>
                    )}
                    <Tag size='small' bordered className='shrink-0'>
                      {t(`manager.schedule.import.kind.${it.kind}`)}
                    </Tag>
                    <span
                      className='size-22px rd-6px flex items-center justify-center cursor-pointer text-t-secondary hover:bg-danger-light-1 hover:text-danger shrink-0'
                      onClick={() => removeItem(it.id)}
                    >
                      <Close theme='outline' size='13' />
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className='text-11px text-t-tertiary mt-4px'>{t('manager.schedule.import.filesHint')}</div>
          </div>
        </div>
      ) : (
        <div className='flex flex-col gap-8px max-h-440px overflow-y-auto'>
          <div className='text-12px text-t-tertiary'>{t('manager.schedule.import.reviewHint')}</div>
          {proposals.map((p, i) => (
            <div
              key={i}
              className='flex items-start gap-10px rd-8px border border-solid border-arco-2 p-10px cursor-pointer hover:bg-fill-1'
              onClick={() => setSelected((prev) => prev.map((v, idx) => (idx === i ? !v : v)))}
            >
              <Checkbox checked={selected[i]} className='mt-2px' />
              <div className='flex-1 min-w-0'>
                <div className='flex items-center gap-8px'>
                  <span className='text-14px text-t-primary truncate'>{p.title}</span>
                  <Tag size='small' color={(p.lockKind ?? 'flexible') === 'fixed' ? 'orange' : 'arcoblue'}>
                    {t(`manager.schedule.${p.lockKind ?? 'flexible'}`)}
                  </Tag>
                </div>
                <div className='text-12px text-t-secondary mt-2px'>{formatTimeRange(p.startAt, p.endAt)}</div>
                {p.location && <div className='text-12px text-t-tertiary'>{p.location}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
};

export default ImportFromImage;
