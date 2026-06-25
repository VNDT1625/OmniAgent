/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useMakeVideoConfig` — persists and exposes the voice + video-clip provider
 * configs for the Make Video Studio. Configs are stored in localStorage so they
 * survive page reloads without requiring a backend round-trip.
 *
 * Renderer-only.
 */

import { useCallback, useState } from 'react';
import type {
  VideoClipConfig,
  VideoClipConfigFal,
  VoiceConfig,
  VoiceConfigElevenLabs,
  VoiceConfigOpenAI,
} from './makeVideoClient';

const VOICE_CONFIG_KEY = 'studio.makeVideo.voiceConfig';
const VIDEO_CLIP_CONFIG_KEY = 'studio.makeVideo.videoClipConfig';

const DEFAULT_VOICE_CONFIG: VoiceConfigOpenAI = {
  type: 'openai',
  base_url: 'https://api.openai.com',
  api_key: '',
  model: 'tts-1',
  voice: 'alloy',
  response_format: 'mp3',
};

const DEFAULT_VIDEO_CLIP_CONFIG: VideoClipConfigFal = {
  type: 'fal',
  api_key: '',
  model_id: 'fal-ai/kling-video/v2.1/standard/image-to-video',
  duration: 5,
};

const loadJson = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    /* ignore */
  }
  return fallback;
};

const saveJson = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
};

export type UseMakeVideoConfig = {
  voiceConfig: VoiceConfig;
  videoClipConfig: VideoClipConfig;
  setVoiceConfig: (config: VoiceConfig) => void;
  setVideoClipConfig: (config: VideoClipConfig) => void;
  /** Whether voice gen is configured (has api_key). */
  voiceReady: boolean;
  /** Whether video clip gen is configured (has api_key). */
  videoClipReady: boolean;
};

export const useMakeVideoConfig = (): UseMakeVideoConfig => {
  const [voiceConfig, setVoiceConfigState] = useState<VoiceConfig>(() =>
    loadJson<VoiceConfig>(VOICE_CONFIG_KEY, DEFAULT_VOICE_CONFIG)
  );
  const [videoClipConfig, setVideoClipConfigState] = useState<VideoClipConfig>(() =>
    loadJson<VideoClipConfig>(VIDEO_CLIP_CONFIG_KEY, DEFAULT_VIDEO_CLIP_CONFIG)
  );

  const setVoiceConfig = useCallback((config: VoiceConfig) => {
    setVoiceConfigState(config);
    saveJson(VOICE_CONFIG_KEY, config);
  }, []);

  const setVideoClipConfig = useCallback((config: VideoClipConfig) => {
    setVideoClipConfigState(config);
    saveJson(VIDEO_CLIP_CONFIG_KEY, config);
  }, []);

  const voiceReady = Boolean(
    voiceConfig.type === 'openai' ? voiceConfig.api_key : (voiceConfig as VoiceConfigElevenLabs).api_key
  );
  const videoClipReady = Boolean((videoClipConfig as VideoClipConfigFal).api_key);

  return { voiceConfig, videoClipConfig, setVoiceConfig, setVideoClipConfig, voiceReady, videoClipReady };
};
