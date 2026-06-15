/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `recorder` — always records a video of a test run + captures milestone
 * screenshots, whether the run is shown or hidden (Yêu cầu 2b, criterion 2.4:
 * "quay video … và chụp ảnh ở các bước quan trọng … dù chạy hiện hay ẩn").
 *
 * The actual frame grabbing / video encoding is OS/display-specific, so it is
 * injected as a {@link CaptureBackend}. This module owns the recording lifecycle
 * (start → snapshot* → stop) and the artifact paths, and is fully testable with
 * a fake backend.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

/** Backend that grabs frames from a virtual display (injected). */
export type CaptureBackend = {
  /** Begin recording video for `target`; resolves with the video file path. */
  startVideo(target: Record<string, string>, outputPath: string): Promise<void>;
  /** Stop the active video recording for `target`. */
  stopVideo(target: Record<string, string>): Promise<void>;
  /** Capture a single screenshot to `outputPath`. */
  snapshot(target: Record<string, string>, outputPath: string): Promise<void>;
};

/** A handle to an in-progress recording. */
export type RecordingHandle = {
  /** Session id this recording belongs to. */
  sessionId: string;
  /** The display target being recorded. */
  target: Record<string, string>;
  /** Filesystem path of the video being written. */
  videoPath: string;
  /** Screenshot paths captured so far. */
  screenshots: string[];
};

/** Options for {@link createRecorder}. */
export type RecorderDeps = {
  /** Frame-capture backend. */
  backend: CaptureBackend;
  /** Directory where artifacts (video + screenshots) are written. */
  outputDir: string;
  /** Path joiner. Defaults to a simple POSIX-ish join. */
  join?: (...parts: string[]) => string;
  /** Clock for unique screenshot names. Defaults to `Date.now`. */
  now?: () => number;
};

/** Public contract of the recorder. */
export type IRecorder = {
  /** Start recording a session's run; always called regardless of visibility. */
  start(sessionId: string, target: Record<string, string>): Promise<RecordingHandle>;
  /** Capture a milestone screenshot (e.g. at the start/end of a step). */
  snapshot(handle: RecordingHandle, label: string): Promise<string>;
  /** Stop recording and return the final artifact paths. */
  stop(handle: RecordingHandle): Promise<{ videoPath: string; screenshots: string[] }>;
};

/** Default path join (kept dependency-free for testability). */
const defaultJoin = (...parts: string[]): string => parts.join('/').replace(/\/+/g, '/');

/** Sanitise a label into a filename-safe token. */
const safeLabel = (label: string): string => label.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'step';

/**
 * Create an {@link IRecorder} over an injected capture backend.
 *
 * @param deps Capture backend + output dir + helpers. See {@link RecorderDeps}.
 * @returns A recorder that always produces a video + milestone screenshots.
 */
export const createRecorder = (deps: RecorderDeps): IRecorder => {
  const join = deps.join ?? defaultJoin;
  const now = deps.now ?? (() => Date.now());

  const start: IRecorder['start'] = async (sessionId, target) => {
    const videoPath = join(deps.outputDir, sessionId, 'recording.webm');
    await deps.backend.startVideo(target, videoPath);
    return { sessionId, target, videoPath, screenshots: [] };
  };

  const snapshot: IRecorder['snapshot'] = async (handle, label) => {
    const file = join(deps.outputDir, handle.sessionId, `${now()}-${safeLabel(label)}.png`);
    await deps.backend.snapshot(handle.target, file);
    handle.screenshots.push(file);
    return file;
  };

  const stop: IRecorder['stop'] = async (handle) => {
    await deps.backend.stopVideo(handle.target);
    return { videoPath: handle.videoPath, screenshots: handle.screenshots };
  };

  return { start, snapshot, stop };
};
