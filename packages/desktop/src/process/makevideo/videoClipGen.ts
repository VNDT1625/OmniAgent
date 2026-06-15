/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Image-to-video clip generation for the Make Video feature.
 *
 * Currently supports the **fal.ai** queue API, which hosts Kling, Wan, LTX,
 * Runway, and many other image-to-video models under a unified interface:
 *
 *   POST  https://queue.fal.run/{model_id}
 *         Authorization: Key {api_key}
 *         Body: { image_url, end_image_url?, prompt, duration? }
 *   → { request_id }
 *
 *   GET   https://queue.fal.run/{model_id}/requests/{request_id}/status
 *   → { status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED", ... }
 *
 *   GET   https://queue.fal.run/{model_id}/requests/{request_id}
 *   → { video: { url: string } }
 *
 * The generated video is downloaded and saved to `userData/make-video/clips/`.
 * All network calls are injectable for unit testing.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VideoClipConfig, VideoClipConfigFal } from './makeVideoTypes';
import { isTransientError, withRetry } from './retry';

/** Minimal fs surface needed (injectable for tests). */
export type VideoClipGenFs = {
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
  writeFile(filePath: string, data: Buffer): Promise<void>;
};

const defaultFs: VideoClipGenFs = {
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
  writeFile: (filePath, data) => fs.promises.writeFile(filePath, data),
};

export type VideoClipGenDeps = {
  fs?: VideoClipGenFs;
  /** Override output directory (defaults to userData/make-video/clips). */
  clipsDir?: string;
  /** Override fetch implementation (injectable for tests). */
  fetchImpl?: typeof fetch;
  /** Poll interval in ms (default 3000). */
  pollIntervalMs?: number;
  /** Max wait time in ms (default 300_000 = 5 min). */
  maxWaitMs?: number;
};

/** Generate a video clip from a start-frame image (and optional end-frame). */
export const generateVideoClip = async (
  frameStartPath: string,
  frameEndPath: string | null | undefined,
  prompt: string,
  config: VideoClipConfig,
  projectId: string,
  sceneId: string,
  deps?: VideoClipGenDeps,
  signal?: AbortSignal
): Promise<string> => {
  if (config.type === 'fal') {
    return generateVideoClipFal(frameStartPath, frameEndPath, prompt, config, projectId, sceneId, deps, signal);
  }
  throw new Error(`Unsupported video clip provider type: ${(config as { type: string }).type}`);
};

// ---------------------------------------------------------------------------
// fal.ai queue-based image-to-video
// ---------------------------------------------------------------------------

/** Convert a local image file to a data URI for fal.ai upload. */
const imageToDataUri = async (imagePath: string): Promise<string> => {
  const data = await fs.promises.readFile(imagePath);
  const ext = path.extname(imagePath).toLowerCase().replace('.', '');
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : 'image/webp';
  return `data:${mime};base64,${data.toString('base64')}`;
};

const FAL_QUEUE_BASE = 'https://queue.fal.run';

const generateVideoClipFal = async (
  frameStartPath: string,
  frameEndPath: string | null | undefined,
  prompt: string,
  config: VideoClipConfigFal,
  projectId: string,
  sceneId: string,
  deps?: VideoClipGenDeps,
  signal?: AbortSignal
): Promise<string> => {
  const fsImpl = deps?.fs ?? defaultFs;
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const pollIntervalMs = deps?.pollIntervalMs ?? 3000;
  const maxWaitMs = deps?.maxWaitMs ?? 300_000;

  const headers = {
    Authorization: `Key ${config.api_key}`,
    'Content-Type': 'application/json',
  };

  // Convert local images to data URIs (fal.ai accepts base64 data URIs).
  const imageUrl = await imageToDataUri(frameStartPath);
  const endImageUrl = frameEndPath ? await imageToDataUri(frameEndPath) : undefined;

  // Build request body — fal.ai models share a common schema.
  const body: Record<string, unknown> = {
    image_url: imageUrl,
    prompt: prompt || 'Cinematic motion, smooth camera movement.',
  };
  if (endImageUrl) body['end_image_url'] = endImageUrl;
  if (config.duration) body['duration'] = config.duration;

  // 1. Submit to queue (retried on transient failures — the submit is cheap and
  //    idempotent; the long-running render only starts once a request_id exists).
  const submitUrl = `${FAL_QUEUE_BASE}/${config.model_id}`;
  const submitJson = await withRetry(
    async () => {
      const submitRes = await fetchImpl(submitUrl, { method: 'POST', headers, body: JSON.stringify(body), signal });
      if (!submitRes.ok) {
        const detail = await submitRes.text().catch(() => '');
        const error = new Error(`fal.ai submit failed (HTTP ${submitRes.status}): ${detail.slice(0, 400)}`);
        (error as Error & { status?: number }).status = submitRes.status;
        throw error;
      }
      return (await submitRes.json()) as { request_id?: string };
    },
    { isRetriable: isTransientError, signal }
  );
  const requestId = submitJson.request_id;
  if (!requestId) throw new Error('fal.ai did not return a request_id.');

  // 2. Poll for completion.
  const statusUrl = `${FAL_QUEUE_BASE}/${config.model_id}/requests/${requestId}/status`;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Video clip generation aborted.');

    await sleep(pollIntervalMs);
    if (signal?.aborted) throw new Error('Video clip generation aborted.');

    const statusRes = await fetchImpl(statusUrl, { headers, signal });
    if (!statusRes.ok) continue; // transient error — keep polling

    const statusJson = (await statusRes.json()) as { status?: string; error?: string };
    if (statusJson.status === 'COMPLETED') break;
    if (statusJson.status === 'FAILED') {
      throw new Error(`fal.ai video generation failed: ${statusJson.error ?? 'unknown error'}`);
    }
    // IN_QUEUE or IN_PROGRESS — keep polling
  }

  if (Date.now() >= deadline) throw new Error('fal.ai video generation timed out after 5 minutes.');

  // 3. Fetch result.
  const resultUrl = `${FAL_QUEUE_BASE}/${config.model_id}/requests/${requestId}`;
  const resultRes = await fetchImpl(resultUrl, { headers, signal });
  if (!resultRes.ok) {
    const detail = await resultRes.text().catch(() => '');
    throw new Error(`fal.ai result fetch failed (HTTP ${resultRes.status}): ${detail.slice(0, 300)}`);
  }
  const resultJson = (await resultRes.json()) as { video?: { url?: string }; videos?: Array<{ url?: string }> };
  const videoUrl = resultJson.video?.url ?? resultJson.videos?.[0]?.url;
  if (!videoUrl) throw new Error('fal.ai result did not contain a video URL.');

  // 4. Download the video.
  const downloadRes = await fetchImpl(videoUrl, { signal });
  if (!downloadRes.ok) throw new Error(`Failed to download video from fal.ai (HTTP ${downloadRes.status}).`);
  const videoBuffer = Buffer.from(await downloadRes.arrayBuffer());

  // 5. Save to disk.
  const clipsDir =
    deps?.clipsDir ?? path.join(process.env['APPDATA'] ?? process.env['HOME'] ?? '', 'make-video', 'clips');
  await fsImpl.mkdir(clipsDir, { recursive: true });
  const fileName = `clip-${projectId}-${sceneId}.mp4`;
  const filePath = path.join(clipsDir, fileName);
  await fsImpl.writeFile(filePath, videoBuffer);
  return filePath;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
