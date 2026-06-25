/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Video render helper for the Automation Make Video node — stitches the
 * rendered scene images into a real `.mp4` using the bundled `ffmpeg-static`
 * binary (no system install needed). Each scene image is shown for a fixed
 * duration via ffmpeg's concat demuxer.
 *
 * The ffmpeg path and the spawn function are injectable so the renderer can be
 * unit-tested without invoking a real ffmpeg process.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveFfmpeg } from '@process/testing/engines/toolResolver';

/** A spawn function compatible with `node:child_process` spawn (injectable). */
export type SpawnFn = (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams;

/** Injectable dependencies for {@link createVideoRenderer}. */
export type VideoRenderDeps = {
  /** Override the ffmpeg binary path. Defaults to the bundled `ffmpeg-static`. */
  ffmpegPath?: string;
  /** Spawn implementation. Defaults to `node:child_process` spawn. */
  spawnImpl?: SpawnFn;
  /** Minimal fs surface (injectable for tests). Defaults to `fs/promises`. */
  fs?: VideoRenderFs;
};

/** The fs operations the renderer needs (injectable for tests). */
export type VideoRenderFs = {
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
  writeFile(filePath: string, data: string): Promise<void>;
  rm(filePath: string, options: { force: true }): Promise<void>;
};

/** Default fs adapter backed by Node's `fs/promises`. */
const defaultFs: VideoRenderFs = {
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
  writeFile: (filePath, data) => fs.promises.writeFile(filePath, data, 'utf-8'),
  rm: (filePath, options) => fs.promises.rm(filePath, options),
};

/** Input for a single rendered scene: its image path + on-screen duration. */
export type RenderScene = {
  /** Absolute path to the scene's rendered image. */
  imagePath: string;
  /** Seconds the image stays on screen. */
  durationSec: number;
};

/** Options for {@link IVideoRenderer.render}. */
export type RenderOptions = {
  /** Ordered scenes to stitch (images shown in array order). */
  scenes: RenderScene[];
  /** Absolute output `.mp4` path. */
  outputPath: string;
  /** Optional abort signal — kills the ffmpeg process if aborted. */
  signal?: AbortSignal;
};

/** Public contract of the video renderer. */
export type IVideoRenderer = {
  /** Stitch the scene images into an `.mp4`; resolves with the output path. */
  render(options: RenderOptions): Promise<string>;
};

/** Build the ffmpeg concat-demuxer manifest (one entry per scene image). */
export const buildConcatManifest = (scenes: RenderScene[]): string => {
  const lines: string[] = [];
  for (const scene of scenes) {
    // ffmpeg concat: escape single quotes in paths by closing/reopening quotes.
    const safePath = scene.imagePath.replace(/'/g, "'\\''");
    lines.push(`file '${safePath}'`);
    lines.push(`duration ${Math.max(0.1, scene.durationSec)}`);
  }
  // The concat demuxer needs the last file repeated so its duration is honoured.
  if (scenes.length > 0) {
    const last = scenes[scenes.length - 1].imagePath.replace(/'/g, "'\\''");
    lines.push(`file '${last}'`);
  }
  return lines.join('\n') + '\n';
};

/**
 * Create a video renderer bound to the given (optionally stubbed) deps.
 *
 * The renderer writes a temporary concat manifest, runs ffmpeg to encode the
 * scene images into an H.264 `.mp4` (yuv420p, even dimensions enforced via a
 * scale filter so any image size is valid), then removes the manifest. Throws a
 * clear error when ffmpeg is unavailable, exits non-zero, or is aborted.
 */
export const createVideoRenderer = (deps?: VideoRenderDeps): IVideoRenderer => {
  const spawnImpl: SpawnFn =
    deps?.spawnImpl ?? ((command, args) => spawn(command, args as string[], { stdio: ['ignore', 'ignore', 'pipe'] }));
  const fsImpl = deps?.fs ?? defaultFs;

  const resolveFfmpegPath = (): string => {
    if (deps?.ffmpegPath) return deps.ffmpegPath;
    const resolution = resolveFfmpeg();
    if (!resolution.ok || !resolution.path) {
      throw new Error(resolution.reason ?? 'Bundled ffmpeg binary not found (ffmpeg-static).');
    }
    return resolution.path;
  };

  return {
    async render(options) {
      const { scenes, outputPath, signal } = options;
      if (scenes.length === 0) throw new Error('Cannot render a video with no scenes.');

      const ffmpegPath = resolveFfmpegPath();
      await fsImpl.mkdir(path.dirname(outputPath), { recursive: true });

      const manifestPath = path.join(os.tmpdir(), `aionui-mv-${randomUUID()}.txt`);
      await fsImpl.writeFile(manifestPath, buildConcatManifest(scenes));

      const args = [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        manifestPath,
        '-vf',
        // Pad to even dimensions so H.264 accepts any input image size.
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-r',
        '30',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx264',
        outputPath,
      ];

      try {
        await runFfmpeg(spawnImpl, ffmpegPath, args, signal);
      } finally {
        await fsImpl.rm(manifestPath, { force: true }).catch((): undefined => undefined);
      }
      return outputPath;
    },
  };
};

/** Run ffmpeg to completion, rejecting on non-zero exit, spawn error, or abort. */
const runFfmpeg = (
  spawnImpl: SpawnFn,
  ffmpegPath: string,
  args: readonly string[],
  signal?: AbortSignal
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Video render aborted.'));
      return;
    }
    const child = spawnImpl(ffmpegPath, args);
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      // Keep only the tail so a huge ffmpeg log never balloons memory.
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const onAbort = (): void => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      reject(new Error('Video render aborted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error: Error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code: number | null) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code ?? 'null'}: ${stderr.trim()}`));
    });
  });
