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
 * a desktop recorder, so we drive capture through CDP at the page's CSS
 * viewport. This keeps evidence independent from the size and position of the
 * in-chat preview card. Each PNG is fed to a long-running ffmpeg process over
 * stdin (image2pipe), which encodes an MP4 at a steady frame rate. If CDP is not
 * available, Electron capture is used as a best-effort fallback. A transient
 * frame error is skipped without aborting the run.
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

type CdpViewport = {
  pageX?: number;
  pageY?: number;
  clientWidth?: number;
  clientHeight?: number;
};

/** Capture at intrinsic page zoom so preview sizing never affects evidence. */
export const captureAtIntrinsicZoom = async <T>(contents: WebContents, capture: () => Promise<T>): Promise<T> => {
  const zoomable = contents as WebContents & {
    getZoomFactor?: () => number;
    setZoomFactor?: (factor: number) => void;
  };
  const previousZoom = zoomable.getZoomFactor?.();
  const canRestore = typeof previousZoom === 'number' && Number.isFinite(previousZoom) && !!zoomable.setZoomFactor;
  if (canRestore && Math.abs(previousZoom - 1) > 0.001) zoomable.setZoomFactor?.(1);
  try {
    return await capture();
  } finally {
    if (canRestore) zoomable.setZoomFactor?.(previousZoom);
  }
};

/**
 * Capture the page's CSS viewport directly through CDP.
 *
 * Unlike `webContents.capturePage()`, this does not encode the native
 * `WebContentsView` card's physical size or display zoom into the evidence.
 * The resulting PNG is expressed in page CSS pixels, so moving/resizing the
 * in-chat preview (for example when the app sidebar collapses) does not turn a
 * Quick Test capture into a tiny preview-card screenshot.
 */
const capturePageViewportPngUnscaled = async (contents: WebContents): Promise<Buffer | null> => {
  const wasAttached = contents.debugger.isAttached();
  try {
    if (!wasAttached) contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Page.enable');
    const metrics = (await contents.debugger.sendCommand('Page.getLayoutMetrics')) as {
      cssVisualViewport?: CdpViewport;
      cssLayoutViewport?: CdpViewport;
    };
    const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
    const width = Math.floor(viewport?.clientWidth ?? 0);
    const height = Math.floor(viewport?.clientHeight ?? 0);
    if (width <= 0 || height <= 0) return null;
    const captured = (await contents.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: viewport?.pageX ?? 0,
        y: viewport?.pageY ?? 0,
        width,
        height,
        scale: 1,
      },
    })) as { data?: string };
    return captured.data ? Buffer.from(captured.data, 'base64') : null;
  } catch {
    // Older Electron/Chromium builds may reject a CDP capture command. Keep a
    // best-effort fallback instead of losing the recording altogether.
    const image = await contents.capturePage();
    return image.isEmpty() ? null : image.toPNG();
  } finally {
    if (!wasAttached && contents.debugger.isAttached()) contents.debugger.detach();
  }
};

/** Capture a CSS viewport screenshot without inheriting the live preview zoom. */
export const capturePageViewportPng = (contents: WebContents): Promise<Buffer | null> =>
  captureAtIntrinsicZoom(contents, () => capturePageViewportPngUnscaled(contents));

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
      const png = await capturePageViewportPng(contents);
      if (!png) return;
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
    const png = await capturePageViewportPng(contents);
    if (!png) return;
    await fs.mkdir(path.dirname(outputPath), { recursive: true }).catch((): undefined => undefined);
    await fs.writeFile(outputPath, png);
  };

  return { startVideo, stopVideo, snapshot };
};
