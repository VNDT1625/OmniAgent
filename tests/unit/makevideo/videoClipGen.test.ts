/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/makevideo/videoClipGen — the fal.ai image-to-video
 * queue flow (submit → poll → result → download → save). fetch + the output fs
 * are injected; a real temp PNG is used as the start frame because the data-URI
 * encoder reads the source image via Node fs directly.
 *
 * Covers:
 * - Happy path: submits with image_url, polls until COMPLETED, downloads + saves.
 * - Retries a transient submit failure (HTTP 503) then succeeds.
 * - Surfaces a FAILED render and a missing video URL.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateVideoClip } from '@/process/makevideo/videoClipGen';
import type { VideoClipConfigFal } from '@/process/makevideo/makeVideoTypes';

let frameDir: string;
let framePath: string;

beforeAll(async () => {
  frameDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mkv-clip-'));
  framePath = path.join(frameDir, 'frame.png');
  await fs.promises.writeFile(framePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterAll(async () => {
  await fs.promises.rm(frameDir, { recursive: true, force: true });
});

const CONFIG: VideoClipConfigFal = {
  type: 'fal',
  api_key: 'fal-key',
  model_id: 'fal-ai/kling-video/v2.1/standard/image-to-video',
  duration: 5,
};

/** Output fs that records writes without touching disk. */
const outFs = () => {
  const writes: string[] = [];
  return {
    writes,
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (p: string) => {
      writes.push(p);
    }),
  };
};

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

describe('generateVideoClip — fal.ai happy path', () => {
  it('submits, polls to COMPLETED, downloads and saves the clip', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ request_id: 'req-1' })) // submit
      .mockResolvedValueOnce(json({ status: 'IN_PROGRESS' })) // status #1
      .mockResolvedValueOnce(json({ status: 'COMPLETED' })) // status #2
      .mockResolvedValueOnce(json({ video: { url: 'https://cdn.fal/clip.mp4' } })) // result
      .mockResolvedValueOnce(new Response(new Uint8Array([9, 9, 9]).buffer, { status: 200 })); // download

    const fsOut = outFs();
    const out = await generateVideoClip(framePath, null, 'pan left', CONFIG, 'p1', 's1', {
      fs: fsOut,
      clipsDir: '/clips',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 0,
      maxWaitMs: 10_000,
    });

    expect(out).toMatch(/clip-p1-s1\.mp4$/);
    expect(fsOut.writes).toHaveLength(1);

    // Submit body carries the data-URI image + prompt.
    const submitBody = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(submitBody.image_url).toMatch(/^data:image\/png;base64,/);
    expect(submitBody.prompt).toBe('pan left');
    expect(submitBody.duration).toBe(5);
  });

  it('retries a transient submit failure then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('upstream', { status: 503 })) // submit fails transiently
      .mockResolvedValueOnce(json({ request_id: 'req-2' })) // submit retry OK
      .mockResolvedValueOnce(json({ status: 'COMPLETED' })) // status
      .mockResolvedValueOnce(json({ video: { url: 'https://cdn.fal/clip2.mp4' } })) // result
      .mockResolvedValueOnce(new Response(new Uint8Array([1]).buffer, { status: 200 })); // download

    const out = await generateVideoClip(framePath, null, '', CONFIG, 'p1', 's2', {
      fs: outFs(),
      clipsDir: '/clips',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 0,
      maxWaitMs: 10_000,
    });
    expect(out).toMatch(/clip-p1-s2\.mp4$/);
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(5);
  });
});

describe('generateVideoClip — failures', () => {
  it('throws when the render reports FAILED', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ request_id: 'req-3' }))
      .mockResolvedValueOnce(json({ status: 'FAILED', error: 'nsfw filter' }));

    await expect(
      generateVideoClip(framePath, null, '', CONFIG, 'p1', 's3', {
        fs: outFs(),
        clipsDir: '/c',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        pollIntervalMs: 0,
        maxWaitMs: 10_000,
      })
    ).rejects.toThrow(/nsfw filter/);
  });

  it('throws when the result lacks a video URL', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ request_id: 'req-4' }))
      .mockResolvedValueOnce(json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(json({ video: {} }));

    await expect(
      generateVideoClip(framePath, null, '', CONFIG, 'p1', 's4', {
        fs: outFs(),
        clipsDir: '/c',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        pollIntervalMs: 0,
        maxWaitMs: 10_000,
      })
    ).rejects.toThrow(/did not contain a video URL/);
  });
});
