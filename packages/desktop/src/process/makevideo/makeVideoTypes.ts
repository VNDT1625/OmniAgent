/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the "Make Video" feature — an AI movie/anime factory that
 * runs entirely via cloud AI APIs (an LLM authors the per-scene script, a cloud
 * image model renders each scene).
 *
 * These types form the renderer-safe contract for both the persistence layer
 * ({@link makeVideoStore}) and the provider-backed IPC bridge
 * ({@link makeVideoBridge}). They are intentionally plain data (no DOM/Node
 * dependencies) so they can be imported from either process.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

/** A single shot/scene of the generated video. */
export type Scene = {
  /** Stable id, generated when the scene is parsed from the model reply. */
  id: string;
  /** Zero-based position of the scene within the project (its ordering). */
  index: number;
  /** Short human-readable scene title (in the project `language`). */
  title: string;
  /** The voice-over / on-screen narration text (in the project `language`). */
  narration: string;
  /** Detailed, English image-generation prompt (camera, lighting, style). */
  imagePrompt: string;
  /** Absolute path to the rendered scene image once generated; else null. */
  imagePath?: string | null;
  /** Last image-generation error for this scene, if any; else null. */
  imageError?: string | null;
  /** Absolute path to the generated voice-over audio file; else null. */
  audioPath?: string | null;
  /** Last voice-generation error for this scene, if any; else null. */
  audioError?: string | null;
  /** Absolute path to the generated video clip (image-to-video); else null. */
  videoClipPath?: string | null;
  /** Last video-clip generation error for this scene, if any; else null. */
  videoClipError?: string | null;
  /**
   * Override for the video clip's start frame image path.
   * Defaults to `imagePath` when absent.
   */
  frameStartPath?: string | null;
  /**
   * Optional end frame image path for image-to-video models that support
   * first-last-frame interpolation (e.g. Kling O3).
   */
  frameEndPath?: string | null;
};

export type FilmCharacter = {
  id: string;
  name: string;
  role: string;
  appearance: string;
  wardrobe: string;
  personality: string;
  voiceNotes: string;
  referenceAssetIds: string[];
};

export type FilmLocation = {
  id: string;
  name: string;
  description: string;
  visualRules: string;
  referenceAssetIds: string[];
};

export type FilmBible = {
  logline: string;
  synopsis: string;
  genre: string;
  tone: string;
  audience: string;
  aspectRatio: '16:9' | '9:16' | '1:1' | '2.39:1';
  visualLanguage: string;
  negativePrompt: string;
  characters: FilmCharacter[];
  locations: FilmLocation[];
};

export type FilmAssetKind = 'image' | 'video' | 'audio' | 'music' | 'subtitle' | 'reference';

export type FilmAsset = {
  id: string;
  kind: FilmAssetKind;
  name: string;
  path: string;
  source: 'generated' | 'imported' | 'recorded';
  sceneId?: string | null;
  tags: string[];
  createdAt: number;
};

export type TimelineClip = {
  id: string;
  sceneId?: string | null;
  assetId?: string | null;
  track: 'video' | 'voice' | 'music' | 'sfx' | 'subtitle';
  startSec: number;
  durationSec: number;
  trimStartSec: number;
  trimEndSec: number;
  volume: number;
  transitionIn?: 'cut' | 'fade' | 'dissolve';
  transitionOut?: 'cut' | 'fade' | 'dissolve';
};

export type FilmTimeline = {
  fps: 24 | 25 | 30 | 60;
  width: number;
  height: number;
  clips: TimelineClip[];
};

export type ProductionTaskStatus = 'pending' | 'ready' | 'running' | 'blocked' | 'done' | 'failed';
export type ProductionAgentRole =
  | 'director'
  | 'screenwriter'
  | 'storyboard'
  | 'continuity'
  | 'visual'
  | 'voice'
  | 'editor'
  | 'qa';

export type ProductionTask = {
  id: string;
  role: ProductionAgentRole;
  title: string;
  status: ProductionTaskStatus;
  sceneId?: string | null;
  dependsOn: string[];
  output?: string | null;
  error?: string | null;
};

export type ProductionPlan = {
  version: 1;
  tasks: ProductionTask[];
  lastRunAt?: number | null;
};

/** A persisted video project — the topic, its scenes, and audit timestamps. */
export type VideoProject = {
  /** Stable project id. */
  id: string;
  /** The user-provided topic / premise the movie is about. */
  topic: string;
  /** Visual/narrative style (e.g. "anime", "noir film", "claymation"). */
  style: string;
  /** Language the narration should be written in (e.g. "English", "Tiếng Việt"). */
  language: string;
  /** The ordered scenes that make up the project. */
  scenes: Scene[];
  /** Creation timestamp (ms since epoch). */
  createdAt: number;
  /** Last-modified timestamp (ms since epoch). */
  updatedAt: number;
  /**
   * Voice provider config snapshot for this project.
   * Stored here so the project is self-contained when re-opened.
   */
  voiceConfig?: VoiceConfig | null;
  /**
   * Video-clip provider config snapshot for this project.
   */
  videoClipConfig?: VideoClipConfig | null;
  /** Persistent creative constraints used to keep characters, locations and style consistent. */
  filmBible?: FilmBible | null;
  /** Searchable source-of-truth for generated and imported production media. */
  assets?: FilmAsset[];
  /** Non-linear edit decision list used by editor agents and final rendering. */
  timeline?: FilmTimeline | null;
  /** Dependency-aware work graph for specialised production agents. */
  productionPlan?: ProductionPlan | null;
};

/** Request payload for the provider-backed script generation step. */
export type ScriptRequest = {
  /** Model id the user picked for script writing (an LLM). */
  model: string;
  /** The topic / premise to turn into a scene-by-scene script. */
  topic: string;
  /** Desired visual/narrative style. */
  style: string;
  /** Language the narration should be written in. */
  language: string;
  /** Exact number of scenes the model must return. */
  sceneCount: number;
};

/**
 * Result envelope shared by every Make Video bridge channel. Handlers always
 * resolve with this shape (never reject) so the renderer can branch on `ok`
 * without the platform bridge swallowing a rejected promise.
 *
 * `code` distinguishes the actionable "nothing configured" cases:
 * - `no-model`: no usable LLM is configured for script generation.
 * - `no-image-model`: no usable cloud image model is configured/selected.
 * - `error`: any other failure.
 */
export type MakeVideoResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: 'no-model' | 'no-image-model' | 'error' };

// ---------------------------------------------------------------------------
// Voice (TTS) config
// ---------------------------------------------------------------------------

/**
 * OpenAI-compatible TTS provider.
 * Endpoint: POST {base_url}/v1/audio/speech
 * Body: { model, input, voice, response_format? }
 * Returns: binary audio (mp3/opus/aac/flac)
 */
export type VoiceConfigOpenAI = {
  type: 'openai';
  /** Base URL of the provider (e.g. "https://api.openai.com"). */
  base_url: string;
  /** API key. */
  api_key: string;
  /** TTS model id (e.g. "tts-1", "tts-1-hd", "gpt-4o-mini-tts"). */
  model: string;
  /** Voice id (e.g. "alloy", "echo", "fable", "onyx", "nova", "shimmer"). */
  voice: string;
  /** Output format. Defaults to "mp3". */
  response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav';
};

/**
 * ElevenLabs TTS provider.
 * Endpoint: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
 * Header: xi-api-key
 * Body: { text, model_id }
 * Returns: binary audio
 */
export type VoiceConfigElevenLabs = {
  type: 'elevenlabs';
  /** ElevenLabs API key. */
  api_key: string;
  /** Voice ID from ElevenLabs voice library. */
  voice_id: string;
  /** Model id (e.g. "eleven_multilingual_v2", "eleven_turbo_v2_5"). */
  model_id: string;
};

export type VoiceConfig = VoiceConfigOpenAI | VoiceConfigElevenLabs;

// ---------------------------------------------------------------------------
// Video-clip (image-to-video) config
// ---------------------------------------------------------------------------

/**
 * fal.ai image-to-video provider.
 * Uses the fal.ai queue API:
 *   POST https://queue.fal.run/{model_id}  → { request_id }
 *   GET  https://queue.fal.run/{model_id}/requests/{request_id}/status
 *   GET  https://queue.fal.run/{model_id}/requests/{request_id}
 *
 * Supported models (examples):
 *   fal-ai/kling-video/v2.1/standard/image-to-video
 *   fal-ai/kling-video/o3/standard/image-to-video  (supports end_image_url)
 *   fal-ai/wan/v2.2-5b/image-to-video
 *   fal-ai/ltxv-13b-098-distilled/image-to-video
 */
export type VideoClipConfigFal = {
  type: 'fal';
  /** fal.ai API key (FAL_KEY). */
  api_key: string;
  /** Full model path on fal.ai (e.g. "fal-ai/kling-video/v2.1/standard/image-to-video"). */
  model_id: string;
  /** Clip duration in seconds (model-dependent, typically 5 or 10). */
  duration?: 5 | 10;
};

export type VideoClipConfig = VideoClipConfigFal;

// ---------------------------------------------------------------------------
// Request / result types for new bridge channels
// ---------------------------------------------------------------------------

/** Request for `makevideo.generate-voice`. */
export type GenerateVoiceRequest = {
  projectId: string;
  sceneId: string;
  /** The narration text to synthesise. */
  text: string;
  /** Voice config to use for this call. */
  voiceConfig: VoiceConfig;
};

/** Result data for `makevideo.generate-voice`. */
export type GenerateVoiceData = {
  /** Absolute path to the saved audio file. */
  audioPath: string;
};

/** Request for `makevideo.generate-video-clip`. */
export type GenerateVideoClipRequest = {
  projectId: string;
  sceneId: string;
  /** Absolute path to the start-frame image. */
  frameStartPath: string;
  /** Absolute path to the end-frame image (optional; not all models support it). */
  frameEndPath?: string | null;
  /** Motion / scene description prompt (English). */
  prompt: string;
  /** Video-clip config to use for this call. */
  videoClipConfig: VideoClipConfig;
};

/** Result data for `makevideo.generate-video-clip`. */
export type GenerateVideoClipData = {
  /** Absolute path to the saved video clip (.mp4). */
  videoClipPath: string;
};

/** Request for `makevideo.export-final`. */
export type ExportFinalRequest = {
  projectId: string;
  /**
   * Ordered list of segments to merge. Each segment is rendered to a normalised
   * clip, then all clips are concatenated.
   *
   * - `videoClipPath`: an existing image-to-video clip (fal.ai). Used as-is, or
   *   muxed with `audioPath` when present.
   * - `imagePath`: a still scene image. When no `videoClipPath` is set, the
   *   image is turned into a clip via ffmpeg (a still "slideshow" segment) so a
   *   video can be exported with NO paid video API — only an LLM + image model
   *   + the bundled ffmpeg. Its length follows `audioPath` (when present) or
   *   `durationSec` (default 5s).
   *
   * At least one of `videoClipPath` / `imagePath` must be set; segments with
   * neither are skipped.
   */
  segments: Array<{
    videoClipPath?: string | null;
    imagePath?: string | null;
    audioPath?: string | null;
    /** Seconds for a still-image segment with no audio. Defaults to 5. */
    durationSec?: number;
  }>;
  /** Absolute output path for the final .mp4. */
  outputPath: string;
};

/** Result data for `makevideo.export-final`. */
export type ExportFinalData = {
  /** Absolute path to the exported final video. */
  outputPath: string;
  /** Total duration in seconds (approximate). */
  durationSec: number;
};
