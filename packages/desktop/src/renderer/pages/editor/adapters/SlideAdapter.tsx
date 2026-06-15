/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `SlideAdapter` — view + edit presentation slides (Yêu cầu 2a, criterion 2.3).
 *
 * Office is the ONLY editing experience the user picks: full WYSIWYG editing via
 * the ONLYOFFICE Document Server (auto-started on demand). The manual "Edit
 * (Office) / Text" switch was removed — Office is always tried first. If the
 * Office editor cannot open (Docker missing, server unreachable, runtime error),
 * the adapter AUTOMATICALLY falls back to a lightweight extracted-text view
 * (Main-process `studio.pptx-read`) so the content stays readable. A slim notice
 * then offers to retry Office or configure the Document Server.
 *
 * Renderer-only.
 */

import { Empty, Result, Spin } from '@arco-design/web-react';
import { FilePpt } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EditorAdapterProps } from '../adapterRegistry';
import { readPptxText } from './studioOfficeClient';
import OnlyOfficeEditor from './OnlyOfficeEditor';
import OnlyOfficeSettingsModal from './OnlyOfficeSettingsModal';
import OfficeFallbackNotice from './OfficeFallbackNotice';

const SLIDE_SEPARATOR = '\n---\n';

/** Extracted slide-text view backed by the Main-process pptx reader. */
const SlideText: React.FC<{ filePath: string }> = ({ filePath }) => {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setText(await readPptxText(filePath));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [filePath]);

  useEffect(() => {
    void load();
  }, [load]);

  const slides = useMemo(() => {
    const parts = text.split(SLIDE_SEPARATOR);
    return parts.length > 0 ? parts : [''];
  }, [text]);
  const current = Math.min(active, slides.length - 1);

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
        icon={<FilePpt theme='outline' size='32' />}
        title={t('editor.slide.openFailed')}
        subTitle={error}
      />
    );
  }

  return (
    <div className='flex-1 min-h-0 flex gap-8px'>
      <div className='w-160px shrink-0 overflow-auto border border-border-base rd-6px p-4px flex flex-col gap-4px'>
        {slides.map((slide, index) => (
          <button
            key={index}
            type='button'
            className={`text-left px-8px py-6px rd-4px text-12px truncate ${index === current ? 'bg-primary text-white' : 'text-t-secondary hover:bg-fill-2'}`}
            onClick={() => setActive(index)}
          >
            {t('editor.slide.slideLabel', { index: index + 1 })}: {slide.trim().slice(0, 18) || t('editor.slide.empty')}
          </button>
        ))}
      </div>
      <div className='flex-1 min-h-0 overflow-auto border border-border-base rd-6px p-16px whitespace-pre-wrap text-14px leading-relaxed text-t-primary'>
        {slides[current]?.trim() || <Empty description={t('editor.slide.empty')} />}
      </div>
    </div>
  );
};

/** Presentation adapter: Office editing by default; auto-falls back to text view. */
const SlideAdapter: React.FC<EditorAdapterProps> = ({ filePath }) => {
  // Office is the default. `fallbackReason` is set when Office can't open, which
  // switches to the lightweight extracted-text view and shows a retry notice.
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
      <SlideText filePath={filePath} />
      <OnlyOfficeSettingsModal visible={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={retryOffice} />
    </div>
  );
};

export default SlideAdapter;
