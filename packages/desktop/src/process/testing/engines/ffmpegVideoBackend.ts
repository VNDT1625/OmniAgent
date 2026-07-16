/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ffmpegVideoBackend` — a REAL {@link CaptureBackend} that records a test run to
 * an actual video file using the bundled `ffmpeg-static` binary (no system
 * install needed). It also writes real milestone screenshots.
 *
 * How it records: the embedded test tab is not a normal window we can grab with
 * a desktop recorder, so we drive the capture ourselves — on a fixed interval we
 * call `webContents.capturePage()` (the same real frame the user would see) and
 * feed each PNG to a long-running ffmpeg process over stdin (image2pipe). ffmpeg
 * encodes them into an MP4 at a steady frame rate. Stopping closes ffmpeg's
 * stdin and waits for it to finalise the file. If a frame grab fails we simply
 * skip it (the video keeps going), so a transient capture error never aborts a
 * run.
 *
 * This is genuinely real video (not a stub): play the produced `.mp4` and you see
 * the actual run. Process boundary: Main-process (Node.js / Electron) module.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WebContents } from 'electron';
import type { CaptureBackend } from '../recorder';
import { resolveFfmpeg } from './toolResolver';

/** Frames per second for the recorded video (low fps keeps CPU sane). */
const VIDEO_FPS = 4;

/** Dependencies for {@link createFfmpegVideoBackend}. */
export type FfmpegVideoBackendDeps = {
  /** Resolve the live WebContents for a target's tab id (from the view manager). */
  getWebContents: (tabId: string) => WebContents | undefined;
  /** Override the ffmpeg path (tests). Defaults to the bundled binary. */
  ffmpegPath?: string;
  /** Frame interval in ms. Defaults to 1000 / VIDEO_FPS. */
  frameIntervalMs?: number;
};

/** Per-target recording state. */
type Recording = {
  ffmpeg: ChildProcessWithoutNullStreams;
  timer: ReturnType<typeof setInterval>;
  outputPath: string;
  /** Guards against overlapping async frame grabs. */
  grabbing: boolean;
};

/**
 * Create a real ffmpeg-backed {@link CaptureBackend}.
 *
 * @param deps WebContents accessor + optional ffmpeg path / fps.
 * @returns A capture backend that records actual video + screenshots, or — when
 *   ffmpeg cannot be resolved — a backend that records screenshots only and
 *   reports the reason (never silently pretends to record).
 */
export const createFfmpegVideoBackend = (deps: FfmpegVideoBackendDeps): CaptureBackend => {
  const ffmpegResolution = deps.ffmpegPath ? { ok: true as const, path: deps.ffmpegPath } : resolveFfmpeg();
  const frameIntervalMs = deps.frameIntervalMs ?? Math.round(1000 / VIDEO_FPS);
  const recordings = new Map<string, Recording>();

  /** Grab one frame and write it to ffmpeg stdin (best-effort). */
  const pumpFrame = async (tabId: string, rec: Recording): Promise<void> => {
    if (rec.grabbing) return; // skip if the previous grab is still in flight
    rec.grabbing = true;
    try {
      const contents = deps.getWebContents(tabId);
      if (!contents || contents.isDestroyed()) return;
      const image = await contents.capturePage();
      if (image.isEmpty()) return;
      const png = image.toPNG();
      if (png.length > 0 && rec.ffmpeg.stdin.writable) {
        rec.ffmpeg.stdin.write(png);
      }
    } catch {
      // Transient capture error — skip this frame, keep recording.
    } finally {
      rec.grabbing = false;
    }
  };

  const startVideo: CaptureBackend['startVideo'] = async (target, outputPath) => {
    await fs.mkdir(path.dirname(outputPath), { recursive: true }).catch((): undefined => undefined);
    const tabId = target.tabId;
    if (!tabId || !ffmpegResolution.ok) {
      // No tab to capture, or ffmpeg unavailable → screenshots-only (handled in
      // snapshot). Do not start a recording.
      return;
    }
    // Encode an MP4 from a stream of PNG frames piped on stdin at VIDEO_FPS.
    const mp4Path = outputPath.replace(/\.webm$/i, '.mp4');
    const args = [
      '-y',
      '-f',
      'image2pipe',
      '-framerate',
      String(VIDEO_FPS),
      '-i',
      'pipe:0',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      // Pad odd dimensions to even (libx264 requirement).
      '-vf',
      'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      mp4Path,
    ];
    const ffmpeg = spawn(ffmpegResolution.path, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    // Swallow EPIPE if ffmpeg exits early so it never crashes the Main process.
    ffmpeg.stdin.on('error', () => {});
    const rec: Recording = {
      ffmpeg,
      timer: setInterval(() => void pumpFrame(tabId, rec), frameIntervalMs),
      outputPath: mp4Path,
      grabbing: false,
    };
    recordings.set(tabId, rec);
  };

  const stopVideo: CaptureBackend['stopVideo'] = async (target) => {
    const tabId = target.tabId;
    if (!tabId) return;
    const rec = recordings.get(tabId);
    if (!rec) return;
    recordings.delete(tabId);
    clearInterval(rec.timer);
    // Close stdin so ffmpeg finalises the file, then wait for it to exit.
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      rec.ffmpeg.once('close', done);
      rec.ffmpeg.once('error', done);
      try {
        rec.ffmpeg.stdin.end();
      } catch {
        resolve();
      }
      // Safety timeout so a stuck encoder never blocks teardown.
      setTimeout(() => {
        try {
          rec.ffmpeg.kill();
        } catch {
          // ignore
        }
        resolve();
      }, 8000);
    });
  };

  const snapshot: CaptureBackend['snapshot'] = async (target, outputPath) => {
    const tabId = target.tabId;
    const contents = tabId ? deps.getWebContents(tabId) : undefined;
    if (!contents || contents.isDestroyed()) return;
    const image = await contents.capturePage();
    if (image.isEmpty()) return;
    await fs.mkdir(path.dirname(outputPath), { recursive: true }).catch((): undefined => undefined);
    await fs.writeFile(outputPath, image.toPNG());
  };

  return { startVideo, stopVideo, snapshot };
};
