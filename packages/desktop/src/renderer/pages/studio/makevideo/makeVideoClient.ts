/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the Make Video IPC surface.
 *
 * The Main-process bridge (`process/makevideo/makeVideoBridge.ts`) imports
 * Node-only modules, so it must not be loaded in the renderer. Mirroring
 * `studioChatClient.ts`, this module re-declares the channel-name strings,
 * rebuilds matching `bridge.buildProvider` invokers, and borrows only **types**
 * via `import type`.
 *
 * Result envelopes always resolve (never reject) on a handled failure, but the
 * script/image calls are long-running provider/image calls, so they are
 * timeout-guarded to surface an unwired bridge as an error rather than an
 * infinite spinner.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type { GenerateImageData, GenerateImageRequest, ProjectIdRequest } from '@process/makevideo/makeVideoBridge';
import type {
  ExportFinalData,
  ExportFinalRequest,
  GenerateVideoClipData,
  GenerateVideoClipRequest,
  GenerateVoiceData,
  GenerateVoiceRequest,
  MakeVideoResult,
  Scene,
  ScriptRequest,
  VideoProject,
} from '@process/makevideo/makeVideoTypes';

/** Make Video IPC channel names (mirror of `MAKE_VIDEO_CHANNELS` in the bridge). */
const MAKE_VIDEO_CHANNELS = {
  listProjects: 'makevideo.list',
  getProject: 'makevideo.get',
  saveProject: 'makevideo.save',
  removeProject: 'makevideo.remove',
  generateScript: 'makevideo.generate-script',
  generateImage: 'makevideo.generate-image',
  generateVoice: 'makevideo.generate-voice',
  generateVideoClip: 'makevideo.generate-video-clip',
  exportFinal: 'makevideo.export-final',
} as const;

/** Short timeout (ms) for CRUD calls. */
const CRUD_TIMEOUT_MS = 8000;
/** Long timeout (ms) for provider-backed script / image generation. */
const GENERATE_TIMEOUT_MS = 180000;

/** Raw typed invokers — each `.invoke(req)` round-trips to the Main process. */
const channels = {
  listProjects: bridge.buildProvider<MakeVideoResult<VideoProject[]>, void>(MAKE_VIDEO_CHANNELS.listProjects),
  getProject: bridge.buildProvider<MakeVideoResult<VideoProject | null>, ProjectIdRequest>(
    MAKE_VIDEO_CHANNELS.getProject
  ),
  saveProject: bridge.buildProvider<MakeVideoResult<VideoProject>, VideoProject>(MAKE_VIDEO_CHANNELS.saveProject),
  removeProject: bridge.buildProvider<MakeVideoResult<VideoProject[]>, ProjectIdRequest>(
    MAKE_VIDEO_CHANNELS.removeProject
  ),
  generateScript: bridge.buildProvider<MakeVideoResult<Scene[]>, ScriptRequest>(MAKE_VIDEO_CHANNELS.generateScript),
  generateImage: bridge.buildProvider<MakeVideoResult<GenerateImageData>, GenerateImageRequest>(
    MAKE_VIDEO_CHANNELS.generateImage
  ),
  generateVoice: bridge.buildProvider<MakeVideoResult<GenerateVoiceData>, GenerateVoiceRequest>(
    MAKE_VIDEO_CHANNELS.generateVoice
  ),
  generateVideoClip: bridge.buildProvider<MakeVideoResult<GenerateVideoClipData>, GenerateVideoClipRequest>(
    MAKE_VIDEO_CHANNELS.generateVideoClip
  ),
  exportFinal: bridge.buildProvider<MakeVideoResult<ExportFinalData>, ExportFinalRequest>(
    MAKE_VIDEO_CHANNELS.exportFinal
  ),
};

/** Error thrown when a Make Video IPC call does not reply within its budget. */
export class MakeVideoBridgeTimeoutError extends Error {
  constructor(channel: string) {
    super(`[MakeVideoClient] No reply on "${channel}" — the Make Video bridge may not be wired yet.`);
    this.name = 'MakeVideoBridgeTimeoutError';
  }
}

/** Race an `invoke` against a timeout so an unregistered channel rejects fast. */
const invokeWithTimeout = <T>(channel: string, call: () => Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new MakeVideoBridgeTimeoutError(channel));
    }, timeoutMs);
    call().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

/** Timeout-guarded Make Video invokers for the renderer. */
export const makeVideoClient = {
  list: (): Promise<MakeVideoResult<VideoProject[]>> =>
    invokeWithTimeout(MAKE_VIDEO_CHANNELS.listProjects, () => channels.listProjects.invoke(), CRUD_TIMEOUT_MS),
  get: (id: string): Promise<MakeVideoResult<VideoProject | null>> =>
    invokeWithTimeout(MAKE_VIDEO_CHANNELS.getProject, () => channels.getProject.invoke({ id }), CRUD_TIMEOUT_MS),
  save: (project: VideoProject): Promise<MakeVideoResult<VideoProject>> =>
    invokeWithTimeout(MAKE_VIDEO_CHANNELS.saveProject, () => channels.saveProject.invoke(project), CRUD_TIMEOUT_MS),
  remove: (id: string): Promise<MakeVideoResult<VideoProject[]>> =>
    invokeWithTimeout(MAKE_VIDEO_CHANNELS.removeProject, () => channels.removeProject.invoke({ id }), CRUD_TIMEOUT_MS),
  generateScript: (request: ScriptRequest): Promise<MakeVideoResult<Scene[]>> =>
    invokeWithTimeout(
      MAKE_VIDEO_CHANNELS.generateScript,
      () => channels.generateScript.invoke(request),
      GENERATE_TIMEOUT_MS
    ),
  generateImage: (request: GenerateImageRequest): Promise<MakeVideoResult<GenerateImageData>> =>
    invokeWithTimeout(
      MAKE_VIDEO_CHANNELS.generateImage,
      () => channels.generateImage.invoke(request),
      GENERATE_TIMEOUT_MS
    ),
  generateVoice: (request: GenerateVoiceRequest): Promise<MakeVideoResult<GenerateVoiceData>> =>
    invokeWithTimeout(
      MAKE_VIDEO_CHANNELS.generateVoice,
      () => channels.generateVoice.invoke(request),
      GENERATE_TIMEOUT_MS
    ),
  generateVideoClip: (request: GenerateVideoClipRequest): Promise<MakeVideoResult<GenerateVideoClipData>> =>
    invokeWithTimeout(
      MAKE_VIDEO_CHANNELS.generateVideoClip,
      () => channels.generateVideoClip.invoke(request),
      GENERATE_TIMEOUT_MS
    ),
  exportFinal: (request: ExportFinalRequest): Promise<MakeVideoResult<ExportFinalData>> =>
    invokeWithTimeout(MAKE_VIDEO_CHANNELS.exportFinal, () => channels.exportFinal.invoke(request), GENERATE_TIMEOUT_MS),
};

export type { MakeVideoResult, Scene, ScriptRequest, VideoProject };
export type { GenerateImageData } from '@process/makevideo/makeVideoBridge';
export type {
  ExportFinalData,
  ExportFinalRequest,
  GenerateVideoClipData,
  GenerateVideoClipRequest,
  GenerateVoiceData,
  GenerateVoiceRequest,
  VoiceConfig,
  VoiceConfigElevenLabs,
  VoiceConfigOpenAI,
  VideoClipConfig,
  VideoClipConfigFal,
} from '@process/makevideo/makeVideoTypes';
