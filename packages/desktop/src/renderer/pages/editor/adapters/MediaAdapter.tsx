/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `MediaAdapter` — play audio/video plus transcription & summary (Yêu cầu 2a,
 * criterion 2.7: "phát mp4/mp3, kèm bóc lời và tóm tắt, chọn online/local, kết
 * quả kèm mốc thời gian"; criterion 2.10: heavy work via the coordinator).
 *
 * Playback uses the native `<video>`/`<audio>` element on a base64 data URL.
 * Transcription/summary are heavy and run in the Main process via the
 * `mediaPipeline` (Yêu cầu 1), so this renderer presents the controls + results;
 * the actual pipeline call is dispatched through the media bridge during
 * integration (Task 15.x). Renderer-only.
 */

import { Alert, Button, Radio, Space } from '@arco-design/web-react';
import { FileText, VoiceOne } from '@icon-park/react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EditorAdapterProps } from '../adapterRegistry';

/** Whether the file is audio (vs video) by extension. */
const isAudio = (filePath: string): boolean => /\.(mp3|wav|ogg|oga|m4a|aac|flac|wma|opus)$/i.test(filePath);

/** Guess a media mime from the extension (defaults to a generic video/audio type). */
const mimeForFile = (filePath: string): string => {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'audio/ogg';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  return isAudio(filePath) ? 'audio/mpeg' : 'video/mp4';
};

/** Where transcription runs: a local model or an online service (criterion 2.7). */
type TranscribeMode = 'local' | 'online';

/**
 * Play media and request transcription/summary. The heavy transcription/summary
 * runs in the Main process (leased); this view collects the mode and renders the
 * (timestamped) result once available.
 */
const MediaAdapter: React.FC<EditorAdapterProps> = ({ filePath, content }) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<TranscribeMode>('local');
  const audio = isAudio(filePath);
  const src = useMemo(
    () => (content.startsWith('data:') ? content : `data:${mimeForFile(filePath)};base64,${content}`),
    [content, filePath]
  );

  return (
    <div className='flex flex-col h-full w-full gap-12px'>
      <div className='shrink-0 bg-fill-2 rd-6px p-12px flex-center'>
        {audio ? (
          <audio src={src} controls className='w-full'>
            <track kind='captions' />
          </audio>
        ) : (
          <video src={src} controls className='max-h-360px w-full object-contain'>
            <track kind='captions' />
          </video>
        )}
      </div>

      <div className='shrink-0 flex flex-wrap items-center gap-12px'>
        <Radio.Group type='button' size='small' value={mode} onChange={(v) => setMode(v as TranscribeMode)}>
          <Radio value='local'>{t('editor.media.local')}</Radio>
          <Radio value='online'>{t('editor.media.online')}</Radio>
        </Radio.Group>
        <Space>
          <Button size='small' icon={<VoiceOne theme='outline' size='14' />} disabled>
            {t('editor.media.transcribe')}
          </Button>
          <Button size='small' icon={<FileText theme='outline' size='14' />} disabled>
            {t('editor.media.summarize')}
          </Button>
        </Space>
      </div>

      <Alert type='info' content={t('editor.media.heavyNotice')} />

      <div className='flex-1 min-h-0 overflow-auto border border-border-base rd-6px p-12px text-13px text-t-tertiary'>
        {t('editor.media.transcriptIdle')}
      </div>
    </div>
  );
};

export default MediaAdapter;
