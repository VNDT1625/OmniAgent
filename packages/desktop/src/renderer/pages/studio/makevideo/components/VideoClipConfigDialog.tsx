/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `VideoClipConfigDialog` — configure the image-to-video provider (fal.ai).
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { Input, Modal, Select } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { VideoClipConfig, VideoClipConfigFal } from '../makeVideoClient';

/** Popular fal.ai image-to-video model IDs. */
const FAL_MODELS = [
  { label: 'Kling 2.1 Standard', value: 'fal-ai/kling-video/v2.1/standard/image-to-video' },
  { label: 'Kling 2.1 Pro', value: 'fal-ai/kling-video/v2.1/pro/image-to-video' },
  { label: 'Kling O3 Standard (start+end frame)', value: 'fal-ai/kling-video/o3/standard/image-to-video' },
  { label: 'Kling O3 Pro (start+end frame)', value: 'fal-ai/kling-video/o3/pro/image-to-video' },
  { label: 'Kling 3.0 Standard', value: 'fal-ai/kling-video/v3/standard/image-to-video' },
  { label: 'Wan 2.2 5B', value: 'fal-ai/wan/v2.2-5b/image-to-video' },
  { label: 'LTX-Video 13B Distilled', value: 'fal-ai/ltxv-13b-098-distilled/image-to-video' },
  { label: 'Stable Video Diffusion', value: 'fal-ai/stable-video' },
];

type VideoClipConfigDialogProps = {
  visible: boolean;
  config: VideoClipConfig;
  onCancel: () => void;
  onSave: (config: VideoClipConfig) => void;
};

const VideoClipConfigDialog: React.FC<VideoClipConfigDialogProps> = ({ visible, config, onCancel, onSave }) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<VideoClipConfigFal>(config as VideoClipConfigFal);

  const handleOk = (): void => {
    onSave(draft);
  };

  const supportsEndFrame = draft.model_id.includes('o3') || draft.model_id.includes('reference');

  return (
    <Modal
      title={t('makeVideo.videoClipConfig.title')}
      visible={visible}
      onCancel={onCancel}
      onOk={handleOk}
      okText={t('makeVideo.videoClipConfig.save')}
      cancelText={t('makeVideo.videoClipConfig.cancel')}
      unmountOnExit
    >
      <div className='flex flex-col gap-14px'>
        <label className='flex flex-col gap-4px'>
          <span className='text-13px text-t-secondary font-[500]'>{t('makeVideo.videoClipConfig.apiKey')}</span>
          <Input.Password
            value={draft.api_key}
            onChange={(v) => setDraft({ ...draft, api_key: v })}
            placeholder='fal-...'
          />
          <span className='text-11px text-t-tertiary'>{t('makeVideo.videoClipConfig.apiKeyHint')}</span>
        </label>

        <label className='flex flex-col gap-4px'>
          <span className='text-13px text-t-secondary font-[500]'>{t('makeVideo.videoClipConfig.model')}</span>
          <Select value={draft.model_id} onChange={(v) => setDraft({ ...draft, model_id: v })} showSearch allowCreate>
            {FAL_MODELS.map((m) => (
              <Select.Option key={m.value} value={m.value}>
                {m.label}
              </Select.Option>
            ))}
          </Select>
          {supportsEndFrame && (
            <span className='text-11px text-success'>✓ {t('makeVideo.videoClipConfig.supportsEndFrame')}</span>
          )}
        </label>

        <label className='flex flex-col gap-4px'>
          <span className='text-13px text-t-secondary font-[500]'>{t('makeVideo.videoClipConfig.duration')}</span>
          <Select value={draft.duration ?? 5} onChange={(v) => setDraft({ ...draft, duration: v as 5 | 10 })}>
            <Select.Option value={5}>5s</Select.Option>
            <Select.Option value={10}>10s</Select.Option>
          </Select>
        </label>
      </div>
    </Modal>
  );
};

export default VideoClipConfigDialog;
