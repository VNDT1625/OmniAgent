/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Media pipeline for the embedded browser + web-browsing agent (Requirement 1 —
 * "Tích hợp trình duyệt và tác nhân duyệt web", criteria 1.5–1.7, 1.9). It is the
 * single place that decides *how* a piece of video/audio is processed:
 *
 * - **Summarise (criterion 1.5):** for a **YouTube** URL it prefers the model's
 *   built-in video summarisation (e.g. Gemini) and **never downloads** the video.
 *   For **non-YouTube** sources it falls back to the heavy path — extract audio
 *   (ffmpeg worker) → transcribe (local/online) → summarise the transcript.
 * - **Transcribe (criteria 1.5 / 2a.7):** extract audio then run speech-to-text
 *   with either a **local** model (Whisper) or an **online** service, chosen by
 *   the caller. Segments always carry start/end timestamps.
 * - **Real-time Vietnamese subtitles (criterion 1.6):** transcribe then translate
 *   each segment to Vietnamese, emitting each {@link SubtitleCue} as soon as it is
 *   ready (via the optional `onCue` callback) so an overlay can render live.
 * - **Voice-over dub (criterion 1.7):** translate the transcript to Vietnamese,
 *   synthesise speech, and produce a dubbed audio artifact. **Not** real-time.
 *
 * ## This module is an ORCHESTRATION / ROUTING layer
 *
 * It contains **no** real ffmpeg / Whisper / Gemini / TTS code. Every heavy
 * collaborator is injected behind a small interface ({@link YouTubeSummarizer},
 * {@link AudioExtractor}, {@link Transcriber}, {@link Translator}, {@link Tts}),
 * so production wiring supplies real workers while unit tests (Task 6.11) inject
 * deterministic stubs and assert the routing: YouTube-vs-non-YouTube branching,
 * local-vs-online transcriber selection, and {@link MediaJob} state transitions.
 *
 * ## Heavy work goes through the ResourceCoordinator (criterion 1.9)
 *
 * Audio extraction, transcription, summarisation, translation and TTS are all
 * heavy. Each is wrapped in `requestLease({ kind, estCostMB })` … then
 * `releaseLease(id)` inside a `try/finally`, so the budget is always freed even
 * when a collaborator throws. There is no dedicated "media"/"ffmpeg" lease kind,
 * so audio extraction reuses {@link TaskKind} `'transcription'` (the closest
 * existing category — extraction only ever exists to feed transcription); all
 * lease kinds are configurable via {@link MediaPipelineDeps}.
 *
 * Process boundary: this is a Main-process (Node.js) module — no DOM APIs. It
 * imports **types only** from its collaborators so it stays decoupled from their
 * concrete implementations.
 */

import type { Lease, LeaseRequest, TaskKind } from '../resource/leaseTypes';

// ---------------------------------------------------------------------------
// Public data models
// ---------------------------------------------------------------------------

/**
 * Where a piece of media comes from. A `url` is fetched/streamed (e.g. a page's
 * video element or a YouTube link); a `file` is a local path (e.g. the Universal
 * Editor's mp4/mp3 adapter, Requirement 2a). YouTube detection only applies to
 * `url` sources.
 */
export type MediaSource = { type: 'url'; url: string } | { type: 'file'; path: string };

/**
 * One span of recognised speech with its position in the media timeline. Times
 * are in **seconds** from the start of the media. `text` is the recognised text
 * in the original spoken language (translation is layered on top for subtitles).
 */
export type TranscriptSegment = {
  /** Start time of the segment, in seconds from the media start. */
  start: number;
  /** End time of the segment, in seconds from the media start. */
  end: number;
  /** Recognised text for this segment, in the original spoken language. */
  text: string;
};

/**
 * A single on-screen subtitle, pairing the original recognised text with its
 * translation (Vietnamese by default — criterion 1.6). Inherits the segment
 * timeline so a renderer knows when to show/hide each cue.
 */
export type SubtitleCue = {
  /** Start time of the cue, in seconds from the media start. */
  start: number;
  /** End time of the cue, in seconds from the media start. */
  end: number;
  /** The original recognised text (source language). */
  original: string;
  /** The translated text shown to the user (target language, default Vietnamese). */
  translated: string;
};

/** Speech-to-text engine location: a local model vs. an online service. */
export type TranscriptionMode = 'local' | 'online';

/** The kind of work a {@link MediaJob} represents (mirrors `design.md`). */
export type MediaJobKind = 'subtitle' | 'dub' | 'transcribe' | 'summarize';

/**
 * Lifecycle state of a {@link MediaJob}.
 * - `queued`  — created, waiting for its first heavy step to acquire a lease.
 * - `running` — at least one heavy step is in flight.
 * - `done`    — completed successfully.
 * - `failed`  — a step threw; see {@link MediaJob.error}.
 */
export type MediaJobStatus = 'queued' | 'running' | 'done' | 'failed';

/**
 * A unit of media work tracked through its lifecycle. Exposed (via
 * {@link IMediaPipeline.getJob}/{@link IMediaPipeline.listJobs}) so the routing
 * unit test (Task 6.11) can assert branching and state transitions.
 */
export type MediaJob = {
  /** Unique identifier for the job. */
  id: string;
  /** What kind of work this job performs. */
  kind: MediaJobKind;
  /** Current lifecycle state. */
  status: MediaJobStatus;
  /** The media this job operates on. */
  source: MediaSource;
  /** Unix-ms timestamp when the job was created. */
  createdAt: number;
  /** Unix-ms timestamp of the most recent state change. */
  updatedAt: number;
  /** Filesystem path of the produced artifact, when the job emits one (e.g. a dub). */
  outputPath?: string;
  /** Human-readable failure message when `status === 'failed'`. */
  error?: string;
};

/** Origin of a {@link MediaSummary}: the YouTube fast path or a transcript. */
export type SummarySource = 'youtube' | 'transcript';

/** Result of {@link IMediaPipeline.summarizeVideo}. */
export type MediaSummary = {
  /** The job that produced this summary. */
  jobId: string;
  /** Which path produced the summary (YouTube fast path vs. transcript fallback). */
  via: SummarySource;
  /** The summary text. */
  summary: string;
  /** The transcript used for the `'transcript'` path (absent for `'youtube'`). */
  transcript?: TranscriptSegment[];
};

/** Result of {@link IMediaPipeline.transcribe}. */
export type TranscriptResult = {
  /** The job that produced this transcript. */
  jobId: string;
  /** Which engine produced the segments. */
  mode: TranscriptionMode;
  /** The recognised segments, ordered and timestamped. */
  segments: TranscriptSegment[];
};

/** Result of {@link IMediaPipeline.generateSubtitles}. */
export type SubtitleResult = {
  /** The job that produced these cues. */
  jobId: string;
  /** BCP-47 language tag the cues were translated into. */
  targetLang: string;
  /** The translated subtitle cues, ordered by start time. */
  cues: SubtitleCue[];
};

/** Result of {@link IMediaPipeline.dub} — a produced voice-over artifact. */
export type DubResult = {
  /** The job that produced this dub. */
  jobId: string;
  /** Filesystem path of the dubbed audio file. */
  outputPath: string;
  /** BCP-47 language tag the dub was spoken in. */
  targetLang: string;
  /** The cues that were synthesised into the dub. */
  cues: SubtitleCue[];
  /** Total duration of the dub in seconds, when the TTS engine reports it. */
  durationSec?: number;
};

// ---------------------------------------------------------------------------
// Injected heavy collaborators (interfaces only — no real impls here)
// ---------------------------------------------------------------------------

/**
 * Summarises a YouTube video directly from its URL using a model's built-in
 * video understanding (e.g. Gemini), **without downloading** the video
 * (criterion 1.5). Injected so the pipeline never hardcodes a concrete model.
 */
export type YouTubeSummarizer = {
  /**
   * Summarise the YouTube video at `url`.
   *
   * @param url The YouTube watch/short/embed URL.
   * @returns The summary text.
   */
  summarize(url: string): Promise<string>;
};

/**
 * Extracts an audio track from a media source. In production this is backed by
 * the ffmpeg worker child-process; here it is an interface so the pipeline only
 * orchestrates. The returned {@link AudioArtifact} is opaque to this module and
 * passed straight to the {@link Transcriber}.
 */
export type AudioExtractor = {
  /**
   * Extract audio from `source`.
   *
   * @param source The media to extract audio from.
   * @returns A handle to the extracted audio (path + optional duration).
   */
  extract(source: MediaSource): Promise<AudioArtifact>;
};

/** Handle to an extracted audio track produced by an {@link AudioExtractor}. */
export type AudioArtifact = {
  /** Filesystem path of the extracted audio file. */
  path: string;
  /** Duration of the audio in seconds, when ffmpeg reports it. */
  durationSec?: number;
};

/**
 * Speech-to-text engine. Its `mode` records whether it is a **local** model or
 * an **online** service so the pipeline can pick between two injected instances
 * (criterion 1.5 / 2a.7). `transcribe` must return timestamped segments.
 */
export type Transcriber = {
  /** Whether this transcriber is a local model or an online service. */
  readonly mode: TranscriptionMode;
  /**
   * Transcribe an extracted audio artifact into timestamped segments.
   *
   * @param audio The audio produced by an {@link AudioExtractor}.
   * @returns The recognised segments, ordered by start time.
   */
  transcribe(audio: AudioArtifact): Promise<TranscriptSegment[]>;
};

/**
 * Translates text between languages. Used to turn recognised segments into
 * Vietnamese subtitle/dub text (criteria 1.6 / 1.7). Injected so the pipeline
 * is engine-agnostic (could be a model call or a dedicated MT service).
 */
export type Translator = {
  /**
   * Translate `texts` into `targetLang`. Returns one translation per input, in
   * the same order, so callers can re-pair them with their source segments.
   *
   * @param texts      The source strings to translate.
   * @param targetLang BCP-47 tag of the desired output language.
   * @returns One translated string per input, in input order.
   */
  translate(texts: string[], targetLang: string): Promise<string[]>;
};

/** A synthesised speech artifact produced by a {@link Tts} engine. */
export type SpeechArtifact = {
  /** Filesystem path of the synthesised audio file. */
  path: string;
  /** Duration of the synthesised audio in seconds, when reported. */
  durationSec?: number;
};

/**
 * Text-to-speech engine used to produce the voice-over dub (criterion 1.7).
 * Injected so the pipeline only orchestrates and never embeds a real TTS engine.
 */
export type Tts = {
  /**
   * Synthesise `cues` into a single dubbed audio artifact in `lang`.
   *
   * @param cues The translated, timestamped cues to voice.
   * @param lang BCP-47 tag of the spoken language.
   * @returns The produced speech artifact.
   */
  synthesize(cues: SubtitleCue[], lang: string): Promise<SpeechArtifact>;
};

/**
 * Minimal subset of the ResourceCoordinator used by the pipeline. The real
 * `IResourceCoordinator` satisfies this structurally, so it can be passed
 * directly; tests inject a lightweight fake.
 */
export type LeaseCoordinator = {
  /** Request a lease for a heavy task; resolves when the budget allows. */
  requestLease: (req: LeaseRequest) => Promise<Lease>;
  /** Release a previously granted lease by id. */
  releaseLease: (id: string) => void;
};

/**
 * Estimated RAM cost (MB) charged against the budget for each heavy step. Each
 * field is optional; omitted fields use {@link DEFAULT_EST_COST_MB}.
 */
export type MediaLeaseCosts = {
  /** Cost charged while the ffmpeg audio extraction runs. */
  extract?: number;
  /** Cost charged while speech-to-text runs. */
  transcribe?: number;
  /** Cost charged while the YouTube/transcript summary runs. */
  summarize?: number;
  /** Cost charged while translation runs. */
  translate?: number;
  /** Cost charged while text-to-speech runs. */
  tts?: number;
};

/**
 * The {@link TaskKind} each heavy step is leased under. Audio extraction has no
 * dedicated kind, so it defaults to `'transcription'` (the work only exists to
 * feed transcription); summarise/translate/tts default to model-style `'agent'`.
 */
export type MediaLeaseKinds = {
  /** Lease kind for ffmpeg audio extraction. Defaults to `'transcription'`. */
  extract?: TaskKind;
  /** Lease kind for speech-to-text. Defaults to `'transcription'`. */
  transcribe?: TaskKind;
  /** Lease kind for the summary model call. Defaults to `'agent'`. */
  summarize?: TaskKind;
  /** Lease kind for translation. Defaults to `'agent'`. */
  translate?: TaskKind;
  /** Lease kind for text-to-speech. Defaults to `'agent'`. */
  tts?: TaskKind;
};

/** Dependencies and tunables for {@link createMediaPipeline}. */
export type MediaPipelineDeps = {
  /** Lease gate; every heavy step runs only while a lease is held (criterion 1.9). */
  coordinator: LeaseCoordinator;
  /** Summarises YouTube videos directly from their URL (no download). */
  youtubeSummarizer: YouTubeSummarizer;
  /** Extracts audio (ffmpeg worker) for the non-YouTube heavy path. */
  audioExtractor: AudioExtractor;
  /** Local speech-to-text engine (Whisper). Used when `mode === 'local'`. */
  localTranscriber: Transcriber;
  /** Online speech-to-text service. Used when `mode === 'online'`. */
  onlineTranscriber: Transcriber;
  /** Translates recognised text into the target subtitle/dub language. */
  translator: Translator;
  /** Text-to-speech engine for the voice-over dub. */
  tts: Tts;
  /** Default transcription mode when a caller does not specify one. Defaults to `'local'`. */
  defaultMode?: TranscriptionMode;
  /** Default target language for subtitles/dub. Defaults to Vietnamese (`'vi'`). */
  defaultTargetLang?: string;
  /** Per-step estimated memory costs (MB). */
  estCostMB?: MediaLeaseCosts;
  /** Per-step lease kinds. */
  leaseKinds?: MediaLeaseKinds;
  /** Unique job-id generator. Defaults to a monotonic counter (`media-<n>`). */
  generateId?: () => string;
  /** Wall-clock source (Unix ms). Defaults to `Date.now`. */
  now?: () => number;
};

/** Options for {@link IMediaPipeline.transcribe}. */
export type TranscribeOptions = {
  /** Which engine to use. Defaults to the pipeline's `defaultMode`. */
  mode?: TranscriptionMode;
};

/** Options for {@link IMediaPipeline.generateSubtitles}. */
export type SubtitleOptions = {
  /** Which transcription engine to use. Defaults to the pipeline's `defaultMode`. */
  mode?: TranscriptionMode;
  /** BCP-47 target language. Defaults to the pipeline's `defaultTargetLang`. */
  targetLang?: string;
  /**
   * Called once per cue **as soon as it is translated**, enabling a live overlay
   * (criterion 1.6). Cues are also returned together in {@link SubtitleResult}.
   */
  onCue?: (cue: SubtitleCue) => void;
};

/** Options for {@link IMediaPipeline.dub}. */
export type DubOptions = {
  /** Which transcription engine to use. Defaults to the pipeline's `defaultMode`. */
  mode?: TranscriptionMode;
  /** BCP-47 target language. Defaults to the pipeline's `defaultTargetLang`. */
  targetLang?: string;
};

/**
 * Public contract of the media pipeline. Implementations route a {@link MediaSource}
 * to the right heavy path and track progress as {@link MediaJob}s.
 */
export type IMediaPipeline = {
  /**
   * Summarise a video. YouTube URLs use the model's built-in summariser (no
   * download); everything else extracts audio, transcribes, then summarises the
   * transcript (criterion 1.5).
   */
  summarizeVideo(source: MediaSource, options?: TranscribeOptions): Promise<MediaSummary>;
  /** Transcribe media into timestamped segments using a local/online engine. */
  transcribe(source: MediaSource, options?: TranscribeOptions): Promise<TranscriptResult>;
  /** Produce translated subtitle cues, emitting each via `onCue` as it is ready (criterion 1.6). */
  generateSubtitles(source: MediaSource, options?: SubtitleOptions): Promise<SubtitleResult>;
  /** Produce a Vietnamese voice-over dub artifact (criterion 1.7; not real-time). */
  dub(source: MediaSource, options?: DubOptions): Promise<DubResult>;
  /** Look up a job by id (for progress UIs and tests). */
  getJob(jobId: string): MediaJob | undefined;
  /** Snapshot of all jobs created by this pipeline, oldest first. */
  listJobs(): MediaJob[];
};

// ---------------------------------------------------------------------------
// YouTube detection (pure, exported for unit testing)
// ---------------------------------------------------------------------------

/** Hostnames (and their subdomains) recognised as YouTube. */
const YOUTUBE_HOSTS = new Set(['youtube.com', 'youtu.be', 'youtube-nocookie.com']);

/**
 * Whether `url` points at a YouTube video. Pure and side-effect free so it can
 * be unit-tested directly (Task 6.11). Matches `youtube.com`, `youtu.be` and
 * `youtube-nocookie.com` plus any subdomain (e.g. `www.`, `m.`, `music.`),
 * across `http`/`https`. Anything unparseable is treated as non-YouTube.
 *
 * @param url The URL to classify.
 * @returns `true` when the URL's host is a YouTube domain.
 */
export const isYouTubeUrl = (url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (YOUTUBE_HOSTS.has(host)) return true;
  // Accept subdomains such as `m.youtube.com` or `music.youtube.com`.
  return [...YOUTUBE_HOSTS].some((domain) => host.endsWith(`.${domain}`));
};

/**
 * Whether a {@link MediaSource} should take the YouTube fast path: it must be a
 * URL source *and* that URL must be a YouTube link.
 *
 * @param source The media source to classify.
 * @returns `true` when the source is a YouTube URL.
 */
export const isYouTubeSource = (source: MediaSource): boolean => source.type === 'url' && isYouTubeUrl(source.url);

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Fallback estimated RAM cost (MB) for any heavy step without an override. */
const DEFAULT_EST_COST_MB = 512;

/** Default target language for subtitles and dubs — Vietnamese (criteria 1.6 / 1.7). */
const DEFAULT_TARGET_LANG = 'vi';

/** Default transcription engine when a caller does not specify one. */
const DEFAULT_MODE: TranscriptionMode = 'local';

/**
 * Default lease kinds per step. Audio extraction reuses `'transcription'`
 * because there is no dedicated media/ffmpeg kind and extraction only ever
 * feeds transcription; model-style steps use `'agent'`.
 */
const DEFAULT_LEASE_KINDS: Required<MediaLeaseKinds> = {
  extract: 'transcription',
  transcribe: 'transcription',
  summarize: 'agent',
  translate: 'agent',
  tts: 'agent',
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an {@link IMediaPipeline} from injected heavy collaborators.
 *
 * The returned pipeline owns an in-memory job registry; each public method
 * creates one {@link MediaJob}, drives it through `queued → running → done`
 * (or `failed`), and gates every heavy step behind the ResourceCoordinator.
 *
 * @param deps Injected collaborators and tunables. See {@link MediaPipelineDeps}.
 * @returns A ready-to-use media pipeline.
 */
export const createMediaPipeline = (deps: MediaPipelineDeps): IMediaPipeline => {
  const { coordinator, youtubeSummarizer, audioExtractor, localTranscriber, onlineTranscriber, translator, tts } = deps;
  const defaultMode = deps.defaultMode ?? DEFAULT_MODE;
  const defaultTargetLang = deps.defaultTargetLang ?? DEFAULT_TARGET_LANG;
  const leaseKinds: Required<MediaLeaseKinds> = { ...DEFAULT_LEASE_KINDS, ...deps.leaseKinds };
  const costs = deps.estCostMB ?? {};
  const now = deps.now ?? (() => Date.now());

  let counter = 0;
  const generateId = deps.generateId ?? (() => `media-${++counter}`);

  /** In-memory job registry, keyed by job id and preserving insertion order. */
  const jobs = new Map<string, MediaJob>();

  /** Cost for a step, falling back to {@link DEFAULT_EST_COST_MB}. */
  const costOf = (step: keyof MediaLeaseCosts): number => costs[step] ?? DEFAULT_EST_COST_MB;

  /** Resolve the transcriber instance for a mode. */
  const transcriberFor = (mode: TranscriptionMode): Transcriber =>
    mode === 'online' ? onlineTranscriber : localTranscriber;

  /** Create a fresh job in the `queued` state and register it. */
  const createJob = (kind: MediaJobKind, source: MediaSource): MediaJob => {
    const ts = now();
    const job: MediaJob = { id: generateId(), kind, status: 'queued', source, createdAt: ts, updatedAt: ts };
    jobs.set(job.id, job);
    return job;
  };

  /** Apply a state transition to a job, stamping `updatedAt`. */
  const transition = (job: MediaJob, patch: Partial<Omit<MediaJob, 'id'>>): void => {
    Object.assign(job, patch, { updatedAt: now() });
  };

  /**
   * Run one heavy step under a resource lease (criterion 1.9). The lease is
   * requested first and always released in `finally`, so the budget is freed
   * even when `work` throws.
   */
  const underLease = async <T>(kind: TaskKind, estCostMB: number, work: () => Promise<T>): Promise<T> => {
    const lease = await coordinator.requestLease({ kind, estCostMB });
    try {
      return await work();
    } finally {
      coordinator.releaseLease(lease.id);
    }
  };

  /**
   * Drive `job` through `running → done/failed` around `run`. The job is marked
   * `running` before the first heavy step and `failed` (with a message) if any
   * step throws, so callers always observe a terminal state.
   */
  const execute = async <T>(job: MediaJob, run: () => Promise<T>): Promise<T> => {
    transition(job, { status: 'running' });
    try {
      const result = await run();
      transition(job, { status: 'done' });
      return result;
    } catch (error) {
      transition(job, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };

  /** Extract audio then transcribe it — the shared non-YouTube heavy path. */
  const extractAndTranscribe = async (source: MediaSource, mode: TranscriptionMode): Promise<TranscriptSegment[]> => {
    const audio = await underLease(leaseKinds.extract, costOf('extract'), () => audioExtractor.extract(source));
    const transcriber = transcriberFor(mode);
    return underLease(leaseKinds.transcribe, costOf('transcribe'), () => transcriber.transcribe(audio));
  };

  /** Translate every segment into `targetLang`, re-pairing results into cues. */
  const toCues = async (segments: TranscriptSegment[], targetLang: string): Promise<SubtitleCue[]> => {
    if (segments.length === 0) return [];
    const translations = await underLease(leaseKinds.translate, costOf('translate'), () =>
      translator.translate(
        segments.map((segment) => segment.text),
        targetLang
      )
    );
    return segments.map((segment, index) => ({
      start: segment.start,
      end: segment.end,
      original: segment.text,
      translated: translations[index] ?? '',
    }));
  };

  const summarizeVideo = async (source: MediaSource, options?: TranscribeOptions): Promise<MediaSummary> => {
    const job = createJob('summarize', source);
    return execute(job, async () => {
      // YouTube fast path: summarise from the URL via the model, no download.
      if (isYouTubeSource(source) && source.type === 'url') {
        const url = source.url;
        const summary = await underLease(leaseKinds.summarize, costOf('summarize'), () =>
          youtubeSummarizer.summarize(url)
        );
        return { jobId: job.id, via: 'youtube', summary } satisfies MediaSummary;
      }
      // Non-YouTube fallback: extract → transcribe → summarise the transcript.
      const mode = options?.mode ?? defaultMode;
      const segments = await extractAndTranscribe(source, mode);
      const transcriptText = segments.map((segment) => segment.text).join('\n');
      const summary = await underLease(leaseKinds.summarize, costOf('summarize'), () =>
        youtubeSummarizer.summarize(transcriptText)
      );
      return { jobId: job.id, via: 'transcript', summary, transcript: segments } satisfies MediaSummary;
    });
  };

  const transcribe = async (source: MediaSource, options?: TranscribeOptions): Promise<TranscriptResult> => {
    const mode = options?.mode ?? defaultMode;
    const job = createJob('transcribe', source);
    return execute(job, async () => {
      const segments = await extractAndTranscribe(source, mode);
      return { jobId: job.id, mode, segments } satisfies TranscriptResult;
    });
  };

  const generateSubtitles = async (source: MediaSource, options?: SubtitleOptions): Promise<SubtitleResult> => {
    const mode = options?.mode ?? defaultMode;
    const targetLang = options?.targetLang ?? defaultTargetLang;
    const job = createJob('subtitle', source);
    return execute(job, async () => {
      const segments = await extractAndTranscribe(source, mode);
      const cues = await toCues(segments, targetLang);
      // Emit each cue for the live overlay as soon as the batch is ready (criterion 1.6).
      if (options?.onCue) for (const cue of cues) options.onCue(cue);
      return { jobId: job.id, targetLang, cues } satisfies SubtitleResult;
    });
  };

  const dub = async (source: MediaSource, options?: DubOptions): Promise<DubResult> => {
    const mode = options?.mode ?? defaultMode;
    const targetLang = options?.targetLang ?? defaultTargetLang;
    const job = createJob('dub', source);
    return execute(job, async () => {
      const segments = await extractAndTranscribe(source, mode);
      const cues = await toCues(segments, targetLang);
      const speech = await underLease(leaseKinds.tts, costOf('tts'), () => tts.synthesize(cues, targetLang));
      transition(job, { outputPath: speech.path });
      return {
        jobId: job.id,
        outputPath: speech.path,
        targetLang,
        cues,
        durationSec: speech.durationSec,
      } satisfies DubResult;
    });
  };

  const getJob = (jobId: string): MediaJob | undefined => {
    const job = jobs.get(jobId);
    return job ? { ...job } : undefined;
  };

  const listJobs = (): MediaJob[] => [...jobs.values()].map((job) => ({ ...job }));

  return { summarizeVideo, transcribe, generateSubtitles, dub, getJob, listJobs };
};
