/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Final video export for the Make Video feature.
 *
 * Takes an ordered list of `{ videoClipPath, audioPath? }` segments and
 * produces a single `.mp4` using the bundled `ffmpeg-static` binary:
 *
 *  1. For each segment that has an audio track, mux the video + audio into a
 *     temporary clip (re-encode audio to AAC, copy video stream).
 *  2. Concatenate all (possibly muxed) clips using the concat demuxer.
 *  3. Output H.264 + AAC `.mp4` with even dimensions.
 *
 * The ffmpeg path and spawn function are injectable for unit testing.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveFfmpeg } from '@process/testing/engines/toolResolver';

export type SpawnFn = (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams;

export type FinalExportFs = {
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
  writeFile(filePath: string, data: string): Promise<void>;
  rm(filePath: string, options: { force: true; recursive?: true }): Promise<void>;
};

const defaultFs: FinalExportFs = {
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
  writeFile: (filePath, data) => fs.promises.writeFile(filePath, data, 'utf-8'),
  rm: (filePath, options) => fs.promises.rm(filePath, options),
};

export type FinalExportDeps = {
  ffmpegPath?: string;
  spawnImpl?: SpawnFn;
  fs?: FinalExportFs;
};

export type ExportSegment = {
  videoClipPath?: string | null;
  imagePath?: string | null;
  audioPath?: string | null;
  /** Seconds for a still-image segment with no audio. Defaults to 5. */
  durationSec?: number;
};

/** Default seconds for a still-image segment that has no audio track. */
const DEFAULT_STILL_DURATION_SEC = 5;

/** Export the final video by merging all segments. Returns the output path. */
export const exportFinalVideo = async (
  segments: ExportSegment[],
  outputPath: string,
  deps?: FinalExportDeps,
  signal?: AbortSignal
): Promise<{ outputPath: string; durationSec: number }> => {
  if (segments.length === 0) throw new Error('Cannot export: no segments provided.');

  const spawnImpl: SpawnFn =
    deps?.spawnImpl ?? ((cmd, args) => spawn(cmd, args as string[], { stdio: ['ignore', 'ignore', 'pipe'] }));
  const fsImpl = deps?.fs ?? defaultFs;

  const ffmpegPath = resolveFfmpegPath(deps?.ffmpegPath);
  const tmpDir = path.join(os.tmpdir(), `aionui-export-${randomUUID()}`);
  await fsImpl.mkdir(tmpDir, { recursive: true });

  try {
    // Step 1: Normalise each segment into a ready-to-concat clip.
    //  - video clip + audio  → mux
    //  - video clip alone     → use as-is
    //  - still image (± audio) → render a slideshow clip via ffmpeg (no paid
    //    video API needed; the whole pipeline can run local + ffmpeg only)
    const readyClips: string[] = [];
    let estimatedSec = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.videoClipPath) {
        if (seg.audioPath) {
          const muxed = path.join(tmpDir, `seg-${i}.mp4`);
          await muxVideoAudio(spawnImpl, ffmpegPath, seg.videoClipPath, seg.audioPath, muxed, signal);
          readyClips.push(muxed);
        } else {
          readyClips.push(seg.videoClipPath);
        }
        estimatedSec += seg.durationSec ?? DEFAULT_STILL_DURATION_SEC;
      } else if (seg.imagePath) {
        const still = path.join(tmpDir, `seg-${i}.mp4`);
        const dur = seg.durationSec && seg.durationSec > 0 ? seg.durationSec : DEFAULT_STILL_DURATION_SEC;
        await stillImageToClip(spawnImpl, ffmpegPath, seg.imagePath, seg.audioPath ?? null, dur, still, signal);
        readyClips.push(still);
        estimatedSec += dur;
      }
      // Segments with neither a clip nor an image are skipped.
    }

    if (readyClips.length === 0) {
      throw new Error('Cannot export: no segment had a video clip or a rendered image.');
    }

    // Step 2: Build concat manifest.
    const manifestPath = path.join(tmpDir, 'concat.txt');
    const manifest = readyClips.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
    await fsImpl.writeFile(manifestPath, manifest);

    // Step 3: Concatenate all clips.
    await fsImpl.mkdir(path.dirname(outputPath), { recursive: true });
    const concatArgs = [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      manifestPath,
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      outputPath,
    ];
    await runFfmpeg(spawnImpl, ffmpegPath, concatArgs, signal);

    return { outputPath, durationSec: estimatedSec || segments.length * DEFAULT_STILL_DURATION_SEC };
  } finally {
    // Clean up temp dir.
    await fsImpl.rm(tmpDir, { force: true, recursive: true }).catch((): undefined => undefined);
  }
};

/**
 * Render a still image into a clip. With audio, the clip lasts the audio length
 * (`-shortest`); without audio it lasts `durationSec`. The image is held static
 * (`-tune stillimage`) and padded to even dimensions for H.264.
 */
const stillImageToClip = (
  spawnImpl: SpawnFn,
  ffmpegPath: string,
  imagePath: string,
  audioPath: string | null,
  durationSec: number,
  outputPath: string,
  signal?: AbortSignal
): Promise<void> => {
  const scale = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const args = audioPath
    ? [
        '-y',
        '-loop',
        '1',
        '-i',
        imagePath,
        '-i',
        audioPath,
        '-c:v',
        'libx264',
        '-tune',
        'stillimage',
        '-pix_fmt',
        'yuv420p',
        '-vf',
        scale,
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-shortest',
        '-movflags',
        '+faststart',
        outputPath,
      ]
    : [
        '-y',
        '-loop',
        '1',
        '-i',
        imagePath,
        '-t',
        String(durationSec),
        '-c:v',
        'libx264',
        '-tune',
        'stillimage',
        '-pix_fmt',
        'yuv420p',
        '-vf',
        scale,
        '-an',
        '-movflags',
        '+faststart',
        outputPath,
      ];
  return runFfmpeg(spawnImpl, ffmpegPath, args, signal);
};

/** Mux a video clip with an audio file into a new .mp4. */
const muxVideoAudio = (
  spawnImpl: SpawnFn,
  ffmpegPath: string,
  videoPath: string,
  audioPath: string,
  outputPath: string,
  signal?: AbortSignal
): Promise<void> => {
  const args = [
    '-y',
    '-i',
    videoPath,
    '-i',
    audioPath,
    // Use shortest stream to avoid silence padding when audio is shorter.
    '-shortest',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    outputPath,
  ];
  return runFfmpeg(spawnImpl, ffmpegPath, args, signal);
};

const resolveFfmpegPath = (override?: string): string => {
  if (override) return override;
  const resolution = resolveFfmpeg();
  if (!resolution.ok || !resolution.path) {
    throw new Error(resolution.reason ?? 'Bundled ffmpeg binary not found (ffmpeg-static).');
  }
  return resolution.path;
};

const runFfmpeg = (
  spawnImpl: SpawnFn,
  ffmpegPath: string,
  args: readonly string[],
  signal?: AbortSignal
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Export aborted.'));
      return;
    }
    const child = spawnImpl(ffmpegPath, args);
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-3000);
    });
    const onAbort = (): void => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error('Export aborted.'));
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
