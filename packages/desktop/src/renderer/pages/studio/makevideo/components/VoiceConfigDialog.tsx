/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `VoiceConfigDialog` — configure the TTS provider for voice generation.
 * Supports OpenAI-compatible and ElevenLabs providers.
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { Input, Modal, Radio, Select } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { VoiceConfig, VoiceConfigElevenLabs, VoiceConfigOpenAI } from '../makeVideoClient';

const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const OPENAI_MODELS = ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'];
const ELEVENLABS_MODELS = ['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_monolingual_v1'];

type VoiceConfigDialogProps = {
  visible: boolean;
  config: VoiceConfig;
  onCancel: () => void;
  onSave: (config: VoiceConfig) => void;
};

const VoiceConfigDialog: React.FC<VoiceConfigDialogProps> = ({ visible, config, onCancel, onSave }) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<VoiceConfig>(config);

  const handleOk = (): void => {
    onSave(draft);
  };

  const switchType = (type: 'openai' | 'elevenlabs'): void => {
    if (type === 'openai') {
      setDraft({
        type: 'openai',
        base_url: 'https://api.openai.com',
        api_key: '',
        model: 'tts-1',
        voice: 'alloy',
        response_format: 'mp3',
      } satisfies VoiceConfigOpenAI);
    } else {
      setDraft({
        type: 'elevenlabs',
        api_key: '',
        voice_id: '',
        model_id: 'eleven_multilingual_v2',
      } satisfies VoiceConfigElevenLabs);
    }
  };

  const isOpenAI = draft.type === 'openai';
  const oai = draft as VoiceConfigOpenAI;
  const el = draft as VoiceConfigElevenLabs;

  return (
    <Modal
      title={t('makeVideo.voiceConfig.title')}
      visible={visible}
      onCancel={onCancel}
      onOk={handleOk}
      okText={t('makeVideo.voiceConfig.save')}
      cancelText={t('makeVideo.voiceConfig.cancel')}
      unmountOnExit
    >
      <div className='flex flex-col gap-14px'>
        {/* Provider type */}
        <label className='flex flex-col gap-4px'>
          <span className='text-13px text-t-secondary font-[500]'>{t('makeVideo.voiceConfig.provider')}</span>
          <Radio.Group value={draft.type} onChange={(v) => switchType(v as 'openai' | 'elevenlabs')}>
            <Radio value='openai'>OpenAI-compatible</Radio>
            <Radio value='elevenlabs'>ElevenLabs</Radio>
          </Radio.Group>
        </label>

        {isOpenAI ? (
          <>
            <label className='flex flex-col gap-4px'>
              <span className='text-13px text-t-secondary font-[500]'>{t('makeVideo.voiceConfig.baseUrl')}</span>
              <Input
                value={oai.base_url}
                onChange={(v) => setDraft({ ...oai, base_url: v })}
                placeholder='https://api.openai.com'
              />
            </label>
            <label className='flex flex-col gap-4px'>
              <span className='text-13px text-t-secondary font-[500]'>{t('makeVideo.voiceConfig.apiKey')}</span>
              <Input.Password
                value={oai.api_key}
                onChange={(v) => setDraft({ ...oai, api_key: v })}
                placeholder='sk-...'
              />
            </label>
            <div className='flex gap-12px'>
              <label className='flex flex-col gap-4px flex-1'>
                <span className='text-13px text-t-secondary font-[500]'>{t('makeVideo.voiceConfig.model')}</span>
                <Select value={oai.model} onChange={(v) => setDraft({ ...oai, model: v })} showSearch allowCreate>
                  {OPENAI_MODELS.map((m) => (
                    <Select.Option key={m} value={m}>
                      {m}
                    </Select.Option>
                  ))}
                </Select>
              </label>
              <label className='flex flex-col gap-4px flex-1'>
                <span className='text-13px text-t-secondary font-[500]'>{t('makeVideo.voiceConfig.voice')}</span>
                <Select value={oai.voice} onChange={(v) => setDraft({ ...oai, voice: v })} showSearch allowCreate>
                  {OPENAI_VOICES.map((v) => (
                    <Select.Option key={v} value={v}>
                      {v}
                    </Select.Option>
                  ))}
                </Select>
              </label>
            </div>
          </>
        ) : (
          <>
            <label className='flex flex-col gap-4px'>
              <span className='text-13px text-t-secondary font-[500]'>{t('makeVideo.voiceConfig.apiKey')}</span>
              <Input.Password
                value={el.api_key}
                onChange={(v) => setDraft({ ...el, api_key: v })}
                placeholder='xi-...'
              />
            </label>
            <label className='flex flex-col gap-4px'>
              <span className='text-13px text-t-secondary font-[500]'>{t('makeVideo.voiceConfig.voiceId')}</span>
              <Input
                value={el.voice_id}
                onChange={(v) => setDraft({ ...el, voice_id: v })}
                placeholder='JBFqnCBsd6RMkjVDRZzb'
              />
            </label>
            <label className='flex flex-col gap-4px'>
              <span className='text-13px text-t-secondary font-[500]'>{t('makeVideo.voiceConfig.model')}</span>
              <Select value={el.model_id} onChange={(v) => setDraft({ ...el, model_id: v })} showSearch allowCreate>
                {ELEVENLABS_MODELS.map((m) => (
                  <Select.Option key={m} value={m}>
                    {m}
                  </Select.Option>
                ))}
              </Select>
            </label>
          </>
        )}
      </div>
    </Modal>
  );
};

export default VoiceConfigDialog;
