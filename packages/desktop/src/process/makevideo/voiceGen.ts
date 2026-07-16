/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Voice generation (TTS) for the Make Video feature.
 *
 * Supports two provider types:
 *  - `openai`: OpenAI-compatible `/v1/audio/speech` endpoint (OpenAI, Azure,
 *    any compatible local server). Returns binary audio directly.
 *  - `elevenlabs`: ElevenLabs `/v1/text-to-speech/{voice_id}` endpoint.
 *    Uses `xi-api-key` header.
 *
 * The generated audio is saved to `userData/make-video/audio/` and the
 * absolute path is returned. Injectable deps for unit testing.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VoiceConfig, VoiceConfigElevenLabs, VoiceConfigOpenAI } from './makeVideoTypes';

/** Minimal fs surface needed (injectable for tests). */
export type VoiceGenFs = {
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
  writeFile(filePath: string, data: Buffer): Promise<void>;
};

const defaultFs: VoiceGenFs = {
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
  writeFile: (filePath, data) => fs.promises.writeFile(filePath, data),
};

export type VoiceGenDeps = {
  fs?: VoiceGenFs;
  /** Override output directory (defaults to userData/make-video/audio). */
  audioDir?: string;
  /** Override fetch implementation (injectable for tests). */
  fetchImpl?: typeof fetch;
};

/** Generate voice audio for a single narration text. Returns the saved file path. */
export const generateVoice = async (
  text: string,
  config: VoiceConfig,
  projectId: string,
  sceneId: string,
  deps?: VoiceGenDeps
): Promise<string> => {
  const fsImpl = deps?.fs ?? defaultFs;
  const fetchImpl = deps?.fetchImpl ?? fetch;

  if (!text.trim()) throw new Error('Voice generation: narration text is empty.');

  let audioBuffer: Buffer;
  if (config.type === 'openai') {
    audioBuffer = await callOpenAiTts(text, config, fetchImpl);
  } else {
    audioBuffer = await callElevenLabsTts(text, config, fetchImpl);
  }

  const ext = config.type === 'openai' ? (config.response_format ?? 'mp3') : 'mp3';
  const fileName = `voice-${projectId}-${sceneId}.${ext}`;
  const audioDir =
    deps?.audioDir ?? path.join(process.env['APPDATA'] ?? process.env['HOME'] ?? '', 'make-video', 'audio');
  await fsImpl.mkdir(audioDir, { recursive: true });
  const filePath = path.join(audioDir, fileName);
  await fsImpl.writeFile(filePath, audioBuffer);
  return filePath;
};

// ---------------------------------------------------------------------------
// OpenAI-compatible TTS
// ---------------------------------------------------------------------------

const callOpenAiTts = async (text: string, config: VoiceConfigOpenAI, fetchImpl: typeof fetch): Promise<Buffer> => {
  const base = config.base_url.replace(/\/+$/, '');
  const url = `${base}/v1/audio/speech`;

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.api_key}`,
    },
    body: JSON.stringify({
      model: config.model,
      input: text,
      voice: config.voice,
      response_format: config.response_format ?? 'mp3',
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenAI TTS failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

// ---------------------------------------------------------------------------
// ElevenLabs TTS
// ---------------------------------------------------------------------------

const callElevenLabsTts = async (
  text: string,
  config: VoiceConfigElevenLabs,
  fetchImpl: typeof fetch
): Promise<Buffer> => {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voice_id)}?output_format=mp3_44100_128`;

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': config.api_key,
    },
    body: JSON.stringify({
      text,
      model_id: config.model_id,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`ElevenLabs TTS failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};
