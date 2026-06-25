/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/makevideo/voiceGen — TTS generation. fetch + fs are
 * injected so no real network or disk is touched.
 *
 * Covers:
 * - OpenAI-compatible: correct endpoint/headers/body, audio saved with the
 *   configured extension.
 * - ElevenLabs: voice-id endpoint + xi-api-key header.
 * - Empty narration rejected; HTTP failures surface the status + body.
 */

import { describe, expect, it, vi } from 'vitest';
import { generateVoice } from '@/process/makevideo/voiceGen';
import type { VoiceConfigElevenLabs, VoiceConfigOpenAI } from '@/process/makevideo/makeVideoTypes';

/** Build a fake `fetch` returning binary audio with the given status. */
const audioFetch = (status = 200) =>
  vi.fn(async () =>
    new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
      status,
      statusText: status === 200 ? 'OK' : 'Bad',
    })
  );

/** In-memory fs capturing the written file. */
const memFs = () => {
  const writes: Array<{ path: string; size: number }> = [];
  return {
    writes,
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (filePath: string, data: Buffer) => {
      writes.push({ path: filePath, size: data.length });
    }),
  };
};

const OPENAI: VoiceConfigOpenAI = {
  type: 'openai',
  base_url: 'https://api.openai.com',
  api_key: 'sk-test',
  model: 'tts-1',
  voice: 'nova',
  response_format: 'wav',
};

describe('generateVoice — OpenAI-compatible', () => {
  it('POSTs to /v1/audio/speech with the right body + saves a .wav', async () => {
    const fetchImpl = audioFetch();
    const fs = memFs();
    const out = await generateVoice('Hello world', OPENAI, 'p1', 's1', { audioDir: '/aud', fs, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'tts-1', input: 'Hello world', voice: 'nova', response_format: 'wav' });
    expect(out).toMatch(/voice-p1-s1\.wav$/);
    expect(fs.writes[0].size).toBe(4);
  });

  it('rejects empty narration before calling the network', async () => {
    const fetchImpl = audioFetch();
    await expect(generateVoice('   ', OPENAI, 'p1', 's1', { fetchImpl, fs: memFs() })).rejects.toThrow(/empty/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces an HTTP failure with status', async () => {
    const fetchImpl = audioFetch(500);
    await expect(generateVoice('hi', OPENAI, 'p1', 's1', { fetchImpl, fs: memFs(), audioDir: '/a' })).rejects.toThrow(
      /OpenAI TTS failed \(HTTP 500\)/
    );
  });
});

describe('generateVoice — ElevenLabs', () => {
  const EL: VoiceConfigElevenLabs = {
    type: 'elevenlabs',
    api_key: 'xi-key',
    voice_id: 'VOICE123',
    model_id: 'eleven_multilingual_v2',
  };

  it('POSTs to the voice-id endpoint with the xi-api-key header', async () => {
    const fetchImpl = audioFetch();
    const fs = memFs();
    const out = await generateVoice('Bonjour', EL, 'p2', 's2', { audioDir: '/aud', fs, fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/text-to-speech/VOICE123');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('xi-key');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ text: 'Bonjour', model_id: 'eleven_multilingual_v2' });
    expect(out).toMatch(/voice-p2-s2\.mp3$/);
  });
});
