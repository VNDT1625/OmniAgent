/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/browser/mediaPipeline — the media job ROUTING layer
 * (Requirement 1.5). The pipeline owns no real ffmpeg/Whisper/Gemini/TTS code;
 * every heavy collaborator is injected, so these tests use in-memory stubs that
 * RECORD their calls and assert the routing decisions:
 *
 * - YouTube vs non-YouTube branching of `summarizeVideo`.
 * - Local vs online transcriber selection (and the configured default).
 * - `generateSubtitles` cue translation + live `onCue` emission.
 * - `MediaJob` lifecycle (queued → running → done / failed) via getJob/listJobs.
 * - Balanced lease request/release around every heavy step (criterion 1.9).
 * - The pure `isYouTubeUrl` / `isYouTubeSource` classifiers.
 *
 * No real ffmpeg/model/disk is touched.
 */

import { describe, expect, it } from 'vitest';
import type {
  AudioArtifact,
  AudioExtractor,
  IMediaPipeline,
  LeaseCoordinator,
  MediaJobStatus,
  MediaPipelineDeps,
  MediaSource,
  SpeechArtifact,
  SubtitleCue,
  Transcriber,
  TranscriptionMode,
  TranscriptSegment,
  Translator,
  Tts,
  YouTubeSummarizer,
} from '@/process/browser/mediaPipeline';
import { createMediaPipeline, isYouTubeSource, isYouTubeUrl } from '@/process/browser/mediaPipeline';
import type { LeaseRequest } from '@/process/resource/leaseTypes';

// ---------------------------------------------------------------------------
// Canned collaborator outputs (deterministic, no real work)
// ---------------------------------------------------------------------------

const LOCAL_SEGMENTS: TranscriptSegment[] = [
  { start: 0, end: 1.5, text: 'local one' },
  { start: 1.5, end: 3, text: 'local two' },
];

const ONLINE_SEGMENTS: TranscriptSegment[] = [{ start: 0, end: 2, text: 'online one' }];

const AUDIO: AudioArtifact = { path: '/tmp/audio.wav', durationSec: 12 };

const SPEECH: SpeechArtifact = { path: '/tmp/dub.mp3', durationSec: 11 };

const NON_YT_URL: MediaSource = { type: 'url', url: 'https://example.com/talk.mp4' };

const FILE_SOURCE: MediaSource = { type: 'file', path: '/videos/clip.mp4' };

// ---------------------------------------------------------------------------
// Test harness: recording stub collaborators + a fake lease coordinator
// ---------------------------------------------------------------------------

type HarnessOptions = {
  defaultMode?: TranscriptionMode;
  defaultTargetLang?: string;
  now?: () => number;
  extractImpl?: (source: MediaSource) => Promise<AudioArtifact>;
  localImpl?: (audio: AudioArtifact) => Promise<TranscriptSegment[]>;
  onlineImpl?: (audio: AudioArtifact) => Promise<TranscriptSegment[]>;
  youtubeImpl?: (arg: string) => Promise<string>;
  translateImpl?: (texts: string[], targetLang: string) => Promise<string[]>;
  ttsImpl?: (cues: SubtitleCue[], lang: string) => Promise<SpeechArtifact>;
};

const createHarness = (options: HarnessOptions = {}) => {
  // Fake ResourceCoordinator: records every request/release and tracks the set
  // of currently-held leases so a test can assert request/release pairing.
  const requested: LeaseRequest[] = [];
  const released: string[] = [];
  const active = new Set<string>();
  let leaseCounter = 0;
  const coordinator: LeaseCoordinator = {
    requestLease: async (req) => {
      requested.push(req);
      const id = `lease-${++leaseCounter}`;
      active.add(id);
      return { id, kind: req.kind, grantedAt: leaseCounter, estCostMB: req.estCostMB };
    },
    releaseLease: (id) => {
      released.push(id);
      active.delete(id);
    },
  };

  const youtubeCalls: string[] = [];
  const youtubeSummarizer: YouTubeSummarizer = {
    summarize: async (arg) => {
      youtubeCalls.push(arg);
      if (options.youtubeImpl) return options.youtubeImpl(arg);
      return `summary::${arg}`;
    },
  };

  const extractorCalls: MediaSource[] = [];
  const audioExtractor: AudioExtractor = {
    extract: async (source) => {
      extractorCalls.push(source);
      if (options.extractImpl) return options.extractImpl(source);
      return AUDIO;
    },
  };

  const localCalls: AudioArtifact[] = [];
  const localTranscriber: Transcriber = {
    mode: 'local',
    transcribe: async (audio) => {
      localCalls.push(audio);
      if (options.localImpl) return options.localImpl(audio);
      return LOCAL_SEGMENTS;
    },
  };

  const onlineCalls: AudioArtifact[] = [];
  const onlineTranscriber: Transcriber = {
    mode: 'online',
    transcribe: async (audio) => {
      onlineCalls.push(audio);
      if (options.onlineImpl) return options.onlineImpl(audio);
      return ONLINE_SEGMENTS;
    },
  };

  const translateCalls: { texts: string[]; targetLang: string }[] = [];
  const translator: Translator = {
    translate: async (texts, targetLang) => {
      translateCalls.push({ texts, targetLang });
      if (options.translateImpl) return options.translateImpl(texts, targetLang);
      return texts.map((text) => `${targetLang}:${text}`);
    },
  };

  const ttsCalls: { cues: SubtitleCue[]; lang: string }[] = [];
  const tts: Tts = {
    synthesize: async (cues, lang) => {
      ttsCalls.push({ cues, lang });
      if (options.ttsImpl) return options.ttsImpl(cues, lang);
      return SPEECH;
    },
  };

  const deps: MediaPipelineDeps = {
    coordinator,
    youtubeSummarizer,
    audioExtractor,
    localTranscriber,
    onlineTranscriber,
    translator,
    tts,
    defaultMode: options.defaultMode,
    defaultTargetLang: options.defaultTargetLang,
    now: options.now,
  };

  const pipeline = createMediaPipeline(deps);

  return {
    pipeline,
    leases: { requested, released, active },
    youtubeCalls,
    extractorCalls,
    localCalls,
    onlineCalls,
    translateCalls,
    ttsCalls,
  };
};

/** A manually-resolvable promise, used to freeze a job mid heavy step. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** Flush the macrotask + microtask queues so suspended async work advances. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// summarizeVideo — YouTube vs non-YouTube branching (criterion 1.5)
// ---------------------------------------------------------------------------

describe('mediaPipeline.summarizeVideo routing', () => {
  it('summarises a YouTube URL via the model without extracting or transcribing', async () => {
    const harness = createHarness();
    const url = 'https://www.youtube.com/watch?v=abc123';

    const result = await harness.pipeline.summarizeVideo({ type: 'url', url });

    expect(result.via).toBe('youtube');
    expect(result.summary).toBe(`summary::${url}`);
    expect(result.transcript).toBeUndefined();
    // The YouTube fast path must NOT touch the heavy download/transcribe path.
    expect(harness.youtubeCalls).toEqual([url]);
    expect(harness.extractorCalls).toEqual([]);
    expect(harness.localCalls).toEqual([]);
    expect(harness.onlineCalls).toEqual([]);
  });

  it('falls back to extract → transcribe → summarise for a non-YouTube URL', async () => {
    const harness = createHarness();

    const result = await harness.pipeline.summarizeVideo(NON_YT_URL);

    const transcriptText = LOCAL_SEGMENTS.map((segment) => segment.text).join('\n');
    expect(result.via).toBe('transcript');
    expect(result.transcript).toEqual(LOCAL_SEGMENTS);
    expect(result.summary).toBe(`summary::${transcriptText}`);
    // Heavy path ran: audio extracted from the source, then the default (local) engine transcribed it.
    expect(harness.extractorCalls).toEqual([NON_YT_URL]);
    expect(harness.localCalls).toEqual([AUDIO]);
    // The summariser was fed the transcript text, not a URL.
    expect(harness.youtubeCalls).toEqual([transcriptText]);
  });

  it('treats a local file as a non-YouTube source and uses the transcript path', async () => {
    const harness = createHarness();

    const result = await harness.pipeline.summarizeVideo(FILE_SOURCE);

    expect(result.via).toBe('transcript');
    expect(harness.extractorCalls).toEqual([FILE_SOURCE]);
    expect(harness.localCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Transcriber selection — local vs online vs configured default
// ---------------------------------------------------------------------------

describe('mediaPipeline transcriber selection', () => {
  it("uses the local transcriber when mode is 'local'", async () => {
    const harness = createHarness();

    const result = await harness.pipeline.transcribe(NON_YT_URL, { mode: 'local' });

    expect(result.mode).toBe('local');
    expect(result.segments).toEqual(LOCAL_SEGMENTS);
    expect(harness.localCalls.length).toBe(1);
    expect(harness.onlineCalls.length).toBe(0);
  });

  it("uses the online transcriber when mode is 'online'", async () => {
    const harness = createHarness();

    const result = await harness.pipeline.transcribe(NON_YT_URL, { mode: 'online' });

    expect(result.mode).toBe('online');
    expect(result.segments).toEqual(ONLINE_SEGMENTS);
    expect(harness.onlineCalls.length).toBe(1);
    expect(harness.localCalls.length).toBe(0);
  });

  it('defaults to the local engine when no mode and no defaultMode are configured', async () => {
    const harness = createHarness();

    const result = await harness.pipeline.transcribe(NON_YT_URL);

    expect(result.mode).toBe('local');
    expect(harness.localCalls.length).toBe(1);
  });

  it('honours the configured defaultMode when a caller omits mode', async () => {
    const harness = createHarness({ defaultMode: 'online' });

    const result = await harness.pipeline.transcribe(NON_YT_URL);

    expect(result.mode).toBe('online');
    expect(harness.onlineCalls.length).toBe(1);
    expect(harness.localCalls.length).toBe(0);
  });

  it('generateSubtitles and dub also respect the requested mode', async () => {
    const harness = createHarness();

    await harness.pipeline.generateSubtitles(NON_YT_URL, { mode: 'online' });
    await harness.pipeline.dub(NON_YT_URL, { mode: 'online' });

    // Two online transcriptions (subtitles + dub), zero local.
    expect(harness.onlineCalls.length).toBe(2);
    expect(harness.localCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// generateSubtitles — translated cues + live onCue emission (criterion 1.6)
// ---------------------------------------------------------------------------

describe('mediaPipeline.generateSubtitles', () => {
  it('translates each segment to Vietnamese by default and emits every cue via onCue', async () => {
    const harness = createHarness();
    const emitted: SubtitleCue[] = [];

    const result = await harness.pipeline.generateSubtitles(NON_YT_URL, { onCue: (cue) => emitted.push(cue) });

    expect(result.targetLang).toBe('vi');
    expect(result.cues).toEqual([
      { start: 0, end: 1.5, original: 'local one', translated: 'vi:local one' },
      { start: 1.5, end: 3, original: 'local two', translated: 'vi:local two' },
    ]);
    // Every returned cue was also streamed live for the overlay.
    expect(emitted).toEqual(result.cues);
    expect(harness.translateCalls).toEqual([{ texts: ['local one', 'local two'], targetLang: 'vi' }]);
  });

  it('translates to a caller-supplied target language', async () => {
    const harness = createHarness();

    const result = await harness.pipeline.generateSubtitles(NON_YT_URL, { targetLang: 'en' });

    expect(result.targetLang).toBe('en');
    expect(result.cues.map((cue) => cue.translated)).toEqual(['en:local one', 'en:local two']);
    expect(harness.translateCalls[0]?.targetLang).toBe('en');
  });

  it('returns no cues and skips translation when transcription is empty', async () => {
    const harness = createHarness({ localImpl: async () => [] });
    const emitted: SubtitleCue[] = [];

    const result = await harness.pipeline.generateSubtitles(NON_YT_URL, { onCue: (cue) => emitted.push(cue) });

    expect(result.cues).toEqual([]);
    expect(emitted).toEqual([]);
    expect(harness.translateCalls).toEqual([]);
    // Only the extract + transcribe leases were taken (no translate lease).
    expect(harness.leases.requested.map((req) => req.kind)).toEqual(['transcription', 'transcription']);
  });
});

// ---------------------------------------------------------------------------
// dub — voice-over artifact (criterion 1.7)
// ---------------------------------------------------------------------------

describe('mediaPipeline.dub', () => {
  it('produces a dub artifact from translated cues and records the output path on the job', async () => {
    const harness = createHarness();

    const result = await harness.pipeline.dub(NON_YT_URL);

    expect(result.outputPath).toBe(SPEECH.path);
    expect(result.durationSec).toBe(SPEECH.durationSec);
    expect(result.targetLang).toBe('vi');
    expect(result.cues.map((cue) => cue.translated)).toEqual(['vi:local one', 'vi:local two']);
    // TTS was given the translated cues in the target language.
    expect(harness.ttsCalls[0]?.lang).toBe('vi');
    expect(harness.pipeline.getJob(result.jobId)?.outputPath).toBe(SPEECH.path);
  });
});

// ---------------------------------------------------------------------------
// MediaJob lifecycle — queued → running → done / failed
// ---------------------------------------------------------------------------

describe('mediaPipeline MediaJob lifecycle', () => {
  it('exposes created jobs through getJob and listJobs', async () => {
    const harness = createHarness();

    const result = await harness.pipeline.transcribe(NON_YT_URL);

    const job = harness.pipeline.getJob(result.jobId);
    expect(job?.kind).toBe('transcribe');
    expect(job?.status).toBe('done');
    expect(harness.pipeline.listJobs().map((entry) => entry.id)).toEqual([result.jobId]);
    expect(harness.pipeline.getJob('does-not-exist')).toBeUndefined();
  });

  it('drives a job through queued → running → done in order', async () => {
    // `now()` is invoked by each state transition *before* the new status is
    // applied, so snapshotting the job at every tick reveals the ordered
    // lifecycle the pipeline documents.
    const holder: { pipeline?: IMediaPipeline } = {};
    const observed: MediaJobStatus[] = [];
    let clock = 0;
    const harness = createHarness({
      now: () => {
        const last = holder.pipeline?.listJobs().at(-1);
        if (last) observed.push(last.status);
        return ++clock;
      },
    });
    holder.pipeline = harness.pipeline;

    const result = await harness.pipeline.transcribe(NON_YT_URL);
    const finalStatus = harness.pipeline.getJob(result.jobId)?.status;

    expect([...observed, finalStatus]).toEqual(['queued', 'running', 'done']);
  });

  it('keeps a job running while a heavy step is in flight, then marks it done', async () => {
    const gate = deferred<AudioArtifact>();
    const harness = createHarness({ extractImpl: () => gate.promise });

    const pending = harness.pipeline.transcribe(NON_YT_URL);
    await tick();

    const jobId = harness.pipeline.listJobs()[0]?.id ?? '';
    expect(harness.pipeline.getJob(jobId)?.status).toBe('running');

    gate.resolve(AUDIO);
    await pending;
    expect(harness.pipeline.getJob(jobId)?.status).toBe('done');
  });

  it('marks a job failed with the collaborator error message when a step throws', async () => {
    const harness = createHarness({
      localImpl: async () => {
        throw new Error('whisper exploded');
      },
    });

    await expect(harness.pipeline.transcribe(NON_YT_URL)).rejects.toThrow('whisper exploded');

    const job = harness.pipeline.listJobs()[0];
    expect(job?.status).toBe('failed');
    expect(job?.error).toBe('whisper exploded');
  });
});

// ---------------------------------------------------------------------------
// Resource leases — every heavy step is acquired and released (criterion 1.9)
// ---------------------------------------------------------------------------

describe('mediaPipeline resource leases', () => {
  it('acquires and releases a balanced lease for every heavy step of a dub', async () => {
    const harness = createHarness();

    await harness.pipeline.dub(NON_YT_URL);

    // extract → transcribe → translate → tts, in order, each released.
    expect(harness.leases.requested.map((req) => req.kind)).toEqual([
      'transcription',
      'transcription',
      'agent',
      'agent',
    ]);
    expect(harness.leases.released.length).toBe(4);
    expect(harness.leases.active.size).toBe(0);
  });

  it('leases the YouTube summary under the agent kind and releases it', async () => {
    const harness = createHarness();

    await harness.pipeline.summarizeVideo({ type: 'url', url: 'https://youtu.be/xyz' });

    expect(harness.leases.requested.map((req) => req.kind)).toEqual(['agent']);
    expect(harness.leases.released.length).toBe(1);
    expect(harness.leases.active.size).toBe(0);
  });

  it('releases held leases even when a heavy step throws', async () => {
    const harness = createHarness({
      localImpl: async () => {
        throw new Error('boom');
      },
    });

    await expect(harness.pipeline.dub(NON_YT_URL)).rejects.toThrow('boom');

    // Extract lease was taken + released; transcribe lease was taken + released
    // (via the try/finally) before the failure propagated. No further steps ran.
    expect(harness.leases.requested.map((req) => req.kind)).toEqual(['transcription', 'transcription']);
    expect(harness.leases.released.length).toBe(2);
    expect(harness.leases.active.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isYouTubeUrl / isYouTubeSource — pure classifiers
// ---------------------------------------------------------------------------

describe('isYouTubeUrl', () => {
  it.each<[string, boolean]>([
    ['https://youtube.com/watch?v=x', true],
    ['https://www.youtube.com/watch?v=x', true],
    ['https://m.youtube.com/watch?v=x', true],
    ['https://music.youtube.com/watch?v=x', true],
    ['https://youtu.be/abc', true],
    ['http://youtu.be/abc', true],
    ['https://youtube-nocookie.com/embed/x', true],
    ['https://www.youtube-nocookie.com/embed/x', true],
    ['https://YouTube.com/watch?v=x', true],
    ['https://example.com/watch?v=x', false],
    ['https://notyoutube.com/watch', false],
    ['https://youtube.com.evil.com/watch', false],
    ['ftp://youtube.com/x', false],
    ['not a url', false],
    ['', false],
  ])('classifies %s as %s', (url, expected) => {
    expect(isYouTubeUrl(url)).toBe(expected);
  });
});

describe('isYouTubeSource', () => {
  it('is true only for URL sources pointing at YouTube', () => {
    expect(isYouTubeSource({ type: 'url', url: 'https://youtu.be/abc' })).toBe(true);
    expect(isYouTubeSource(NON_YT_URL)).toBe(false);
  });

  it('is false for file sources even when the path looks YouTube-ish', () => {
    expect(isYouTubeSource({ type: 'file', path: '/downloads/youtube.com.mp4' })).toBe(false);
  });
});
