/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `NewProjectDialog` — collects a new video project's premise: the topic, a
 * visual style, and the narration language. Style is a free-text field with a
 * few quick-pick chips (anime / cinematic / claymation / …). Renderer-only; all
 * text via i18n; Arco components only.
 */

import { Input, Modal, Select } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

const { TextArea } = Input;

type NewProjectDialogProps = {
  visible: boolean;
  onCancel: () => void;
  onCreate: (topic: string, style: string, language: string) => void;
};

/** Quick-pick style chips (free text underneath). */
const STYLE_PRESETS = ['anime', 'cinematic', 'claymation', 'pixel art', 'watercolor', 'noir'];

const NewProjectDialog: React.FC<NewProjectDialogProps> = ({ visible, onCancel, onCreate }) => {
  const { t } = useTranslation();
  const [topic, setTopic] = useState('');
  const [style, setStyle] = useState('anime');
  const [language, setLanguage] = useState('English');

  const handleOk = (): void => {
    if (topic.trim().length === 0) return;
    onCreate(topic.trim(), style.trim() || 'anime', language.trim() || 'English');
    setTopic('');
  };

  return (
    <Modal
      title={t('makeVideo.new.title')}
      visible={visible}
      onCancel={onCancel}
      onOk={handleOk}
      okText={t('makeVideo.new.create')}
      cancelText={t('makeVideo.new.cancel')}
      okButtonProps={{ disabled: topic.trim().length === 0 }}
      unmountOnExit
    >
      <div className='flex flex-col gap-12px'>
        <label className='flex flex-col gap-4px'>
          <span className='text-13px text-t-secondary font-[500]'>{t('makeVideo.new.topic')}</span>
          <TextArea
            value={topic}
            onChange={setTopic}
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder={t('makeVideo.new.topicPlaceholder')}
            autoFocus
          />
        </label>

        <label className='flex flex-col gap-4px'>
          <span className='text-13px text-t-secondary font-[500]'>{t('makeVideo.new.style')}</span>
          <Input value={style} onChange={setStyle} placeholder={t('makeVideo.new.stylePlaceholder')} />
          <span className='flex flex-wrap gap-6px pt-2px'>
            {STYLE_PRESETS.map((preset) => (
              <button
                key={preset}
                type='button'
                onClick={() => setStyle(preset)}
                className={`px-8px py-2px rd-full text-12px cursor-pointer border-none transition-colors ${style === preset ? 'bg-primary text-white' : 'bg-fill-2 text-t-secondary hover:bg-fill-3'}`}
              >
                {preset}
              </button>
            ))}
          </span>
        </label>

        <label className='flex flex-col gap-4px'>
          <span className='text-13px text-t-secondary font-[500]'>{t('makeVideo.new.language')}</span>
          <Select value={language} onChange={setLanguage}>
            {['English', 'Tiếng Việt', '中文', '日本語', '한국어'].map((lang) => (
              <Select.Option key={lang} value={lang}>
                {lang}
              </Select.Option>
            ))}
          </Select>
        </label>
      </div>
    </Modal>
  );
};

export default NewProjectDialog;
