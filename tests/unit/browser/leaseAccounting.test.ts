/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Property + unit tests for Property 2 ("Mọi tác vụ nặng đi qua coordinator")
 * spanning BOTH heavy-work modules of the browser stack:
 *   - process/browser/pagePerception — `capture` leases `'browser'`; the light
 *     reads (`readText`, `readAccessibilityTree`) take NO lease.
 *   - process/browser/mediaPipeline  — every heavy step (extract / transcribe /
 *     summarize / translate / tts) wraps `requestLease` … `releaseLease`.
 *
 * The invariant under test is LEASE BALANCE, not routing (routing already lives
 * in mediaPipeline.test.ts): after ANY operation completes — success OR throw —
 * the coordinator must hold no leases, and the multiset of `releaseLease` ids
 * must be a permutation of the granted ids (each granted lease released exactly
 * once, no double-release, no release-without-grant). `try/finally` in both
 * modules must guarantee this even when a collaborator throws mid-flight.
 *
 * fast-check is not a dependency of this repo, so the universal invariant is
 * exercised with a deterministic seeded PRNG (mulberry32) + randomized loops
 * over randomized operation sequences and randomized failure-injection points.
 * Each failing case reports its run index and seed for reproducibility.
 *
 * Stubs only — no Electron, no real ffmpeg/Whisper/model/disk.
 *
 * Validates: Requirements 1.9
 */

import { describe, expect, it } from 'vitest';
import { createMediaPipeline } from '@/process/browser/mediaPipeline';
import type {
  AudioArtifact,
  AudioExtractor,
  IMediaPipeline,
  MediaSource,
  SpeechArtifact,
  Transcriber,
  TranscriptionMode,
  TranscriptSegment,
  Translator,
  Tts,
  YouTubeSummarizer,
} from '@/process/browser/mediaPipeline';
import { createPagePerception } from '@/process/browser/pagePerception';
import type { CapturedImage, IPagePerception, PageDriver } from '@/process/browser/pagePerception';
import type { Lease, LeaseRequest, TaskKind } from '@/process/resource/leaseTypes';

// ---------------------------------------------------------------------------
// Deterministic property-testing harness (no external deps) — mirrors
// tests/unit/company/contextLayering.test.ts so conventions stay consistent.
// ---------------------------------------------------------------------------

/** Number of randomized cases for the sequential property. */
const PROPERTY_RUNS = 200;

/** Number of randomized cases for the concurrent property. */
const CONCURRENT_RUNS = 100;

/** mulberry32 — a small, fast, deterministic PRNG seeded by a single integer. */
const makeRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Run an async `check` over many deterministic seeds. On the first failing case
 * the original assertion error is re-thrown with the run index and seed attached
 * so the counterexample is reproducible.
 */
const forAllSeedsAsync = async (
  runs: number,
  check: (rng: () => number, run: number) => Promise<void>
): Promise<void> => {
  for (let run = 0; run < runs; run++) {
    const seed = ((run + 1) * 0x9e3779b1) >>> 0;
    try {
      await check(makeRng(seed), run);
    } catch (error) {
      throw new Error(`Property failed on run ${run} (seed ${seed}): ${(error as Error).message}`, { cause: error });
    }
  }
};

const randInt = (rng: () => number, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));

// ---------------------------------------------------------------------------
// Fake LeaseCoordinator with full grant/release accounting
// ---------------------------------------------------------------------------

/** One granted lease, remembered so releases can be matched back to grants. */
type GrantRecord = { id: string; kind: TaskKind };

/**
 * A lease coordinator that grants instantly (no budget gating — Property 3
 * covers gating elsewhere) but records everything needed to prove lease balance:
 * every grant, every release, the set currently held, plus any double-release
 * or release-without-grant it observes.
 */
const createFakeCoordinator = () => {
  const grants: GrantRecord[] = [];
  const releases: string[] = [];
  const held = new Set<string>();
  const grantedIds = new Set<string>();
  const doubleReleases: string[] = [];
  const releasesWithoutGrant: string[] = [];
  let counter = 0;

  const requestLease = async (req: LeaseRequest): Promise<Lease> => {
    const id = `lease-${++counter}`;
    grants.push({ id, kind: req.kind });
    grantedIds.add(id);
    held.add(id);
    return { id, kind: req.kind, grantedAt: counter, estCostMB: req.estCostMB };
  };

  const releaseLease = (id: string): void => {
    releases.push(id);
    if (!grantedIds.has(id)) {
      releasesWithoutGrant.push(id);
    } else if (!held.has(id)) {
      doubleReleases.push(id);
    }
    held.delete(id);
  };

  return { coordinator: { requestLease, releaseLease }, grants, releases, held, doubleReleases, releasesWithoutGrant };
};

type Accounting = ReturnType<typeof createFakeCoordinator>;

/** The core Property 2 invariant: leases are perfectly balanced. */
const assertBalanced = (accounting: Accounting): void => {
  // Nothing is still held once every operation has settled.
  expect(accounting.held.size).toBe(0);
  // No lease was released twice, and no unknown id was ever released.
  expect(accounting.doubleReleases).toEqual([]);
  expect(accounting.releasesWithoutGrant).toEqual([]);
  // Releases form a permutation of grants (each granted id released exactly once).
  expect([...accounting.releases].toSorted()).toEqual(accounting.grants.map((grant) => grant.id).toSorted());
};

// ---------------------------------------------------------------------------
// Canned collaborator outputs + failure-injection points
// ---------------------------------------------------------------------------

const AUDIO: AudioArtifact = { path: '/tmp/audio.wav', durationSec: 12 };
const SPEECH: SpeechArtifact = { path: '/tmp/dub.mp3', durationSec: 11 };
const LOCAL_SEGMENTS: TranscriptSegment[] = [
  { start: 0, end: 1.5, text: 'local one' },
  { start: 1.5, end: 3, text: 'local two' },
];
const ONLINE_SEGMENTS: TranscriptSegment[] = [{ start: 0, end: 2, text: 'online one' }];

const YT_URL: MediaSource = { type: 'url', url: 'https://www.youtube.com/watch?v=abc123' };
const WEB_URL: MediaSource = { type: 'url', url: 'https://example.com/talk.mp4' };
const FILE_SRC: MediaSource = { type: 'file', path: '/videos/clip.mp4' };
const SOURCES: MediaSource[] = [YT_URL, WEB_URL, FILE_SRC];

/** Each heavy collaborator that can be made to throw, plus `'none'`. */
type FailPoint = 'none' | 'extract' | 'transcribe' | 'translate' | 'tts' | 'summarize' | 'capture';
const FAIL_POINTS: FailPoint[] = ['none', 'extract', 'transcribe', 'translate', 'tts', 'summarize', 'capture'];

// ---------------------------------------------------------------------------
// Harness: a pagePerception + mediaPipeline sharing ONE accounting coordinator
// ---------------------------------------------------------------------------

type Harness = {
  accounting: Accounting;
  pipeline: IMediaPipeline;
  perception: IPagePerception;
};

/**
 * Build a perception layer and media pipeline wired to the same accounting
 * coordinator. When `failPoint` names a heavy collaborator, that collaborator
 * throws on every call, so the `try/finally` release paths are exercised.
 */
const createHarness = (failPoint: FailPoint = 'none'): Harness => {
  const accounting = createFakeCoordinator();
  const failIf = (step: FailPoint): void => {
    if (step === failPoint) throw new Error(`injected:${step}`);
  };

  const youtubeSummarizer: YouTubeSummarizer = {
    summarize: async (arg) => {
      failIf('summarize');
      return `summary::${arg}`;
    },
  };
  const audioExtractor: AudioExtractor = {
    extract: async (_source) => {
      failIf('extract');
      return AUDIO;
    },
  };
  const localTranscriber: Transcriber = {
    mode: 'local',
    transcribe: async (_audio) => {
      failIf('transcribe');
      return LOCAL_SEGMENTS;
    },
  };
  const onlineTranscriber: Transcriber = {
    mode: 'online',
    transcribe: async (_audio) => {
      failIf('transcribe');
      return ONLINE_SEGMENTS;
    },
  };
  const translator: Translator = {
    translate: async (texts, targetLang) => {
      failIf('translate');
      return texts.map((text) => `${targetLang}:${text}`);
    },
  };
  const tts: Tts = {
    synthesize: async (_cues, _lang) => {
      failIf('tts');
      return SPEECH;
    },
  };

  const pipeline = createMediaPipeline({
    coordinator: accounting.coordinator,
    youtubeSummarizer,
    audioExtractor,
    localTranscriber,
    onlineTranscriber,
    translator,
    tts,
  });

  const image: CapturedImage = {
    toDataURL: () => 'data:image/png;base64,AAAA',
    toPNG: () => new Uint8Array([1, 2, 3]),
    getSize: () => ({ width: 800, height: 600 }),
    isEmpty: () => false,
  };
  const driver: PageDriver = {
    // The accessibility snippet embeds `MAX_DEPTH`; the text snippet does not.
    executeJavaScript: async (code) =>
      code.includes('MAX_DEPTH') ? { role: 'body', name: '', children: [] } : 'page text',
    capturePage: async () => {
      failIf('capture');
      return image;
    },
  };
  const perception = createPagePerception({
    getWebContents: (tabId) => (tabId === 'tab-1' ? driver : undefined),
    mediaPipeline: pipeline,
    coordinator: accounting.coordinator,
  });

  return { accounting, pipeline, perception };
};

// ---------------------------------------------------------------------------
// Operation generator — a random heavy/light op routed through either module
// ---------------------------------------------------------------------------

const genSource = (rng: () => number): MediaSource => SOURCES[randInt(rng, 0, SOURCES.length - 1)];

const genMode = (rng: () => number): TranscriptionMode => (rng() < 0.5 ? 'local' : 'online');

/** Pick one random operation across both modules (some heavy, some light). */
const genOp = (harness: Harness, rng: () => number): (() => Promise<unknown>) => {
  const source = genSource(rng);
  const mode = genMode(rng);
  switch (randInt(rng, 0, 8)) {
    case 0: {
      // capture occasionally targets an unknown tab → fails BEFORE leasing.
      const tabId = rng() < 0.8 ? 'tab-1' : 'missing';
      return () => harness.perception.capture(tabId);
    }
    case 1:
      return () => harness.perception.readText('tab-1');
    case 2:
      return () => harness.perception.readAccessibilityTree('tab-1');
    case 3:
      return () => harness.perception.perceiveMedia({ action: 'summarize', source });
    case 4:
      return () => harness.perception.perceiveMedia({ action: 'transcribe', source, options: { mode } });
    case 5:
      return () => harness.pipeline.summarizeVideo(source);
    case 6:
      return () => harness.pipeline.transcribe(source, { mode });
    case 7:
      return () => harness.pipeline.generateSubtitles(source, { mode });
    default:
      return () => harness.pipeline.dub(source, { mode });
  }
};

// ---------------------------------------------------------------------------
// Property 2 — lease balance across randomized sequences + failure injection
// ---------------------------------------------------------------------------

describe('Property 2: Mọi tác vụ nặng đi qua coordinator (Requirements 1.9)', () => {
  it('keeps leases balanced after every op in a randomized sequence, with random failure injection', async () => {
    await forAllSeedsAsync(PROPERTY_RUNS, async (rng) => {
      const failPoint = FAIL_POINTS[randInt(rng, 0, FAIL_POINTS.length - 1)];
      const harness = createHarness(failPoint);

      const opCount = randInt(rng, 1, 12);
      for (let i = 0; i < opCount; i++) {
        const op = genOp(harness, rng);
        // Injected failures (and unknown-tab lookups) are expected to throw; the
        // try/finally release paths must still leave the coordinator balanced.
        try {
          await op();
        } catch {
          // swallow — the invariant, not the outcome, is what matters here.
        }
        assertBalanced(harness.accounting);
      }
    });
  });

  it('keeps leases balanced when many heavy ops run concurrently, with random failure injection', async () => {
    await forAllSeedsAsync(CONCURRENT_RUNS, async (rng) => {
      const failPoint = FAIL_POINTS[randInt(rng, 0, FAIL_POINTS.length - 1)];
      const harness = createHarness(failPoint);

      const opCount = randInt(rng, 2, 10);
      const inflight: Promise<unknown>[] = [];
      for (let i = 0; i < opCount; i++) {
        inflight.push(genOp(harness, rng)().catch(() => undefined));
      }
      await Promise.all(inflight);

      // Once every concurrent op has settled, nothing is held and grants ↔ releases pair up.
      assertBalanced(harness.accounting);
    });
  });
});

// ---------------------------------------------------------------------------
// Example-based guards — pin the EXACT leases each heavy/light op takes
// ---------------------------------------------------------------------------

describe('Property 2: heavy ops acquire a lease, light reads do not (Requirements 1.9)', () => {
  it('capture acquires exactly one browser lease and releases it', async () => {
    const harness = createHarness();

    await harness.perception.capture('tab-1');

    expect(harness.accounting.grants.map((grant) => grant.kind)).toEqual(['browser']);
    assertBalanced(harness.accounting);
  });

  it('summarizeVideo for a non-YouTube source leases extract + transcribe + summarize', async () => {
    const harness = createHarness();

    await harness.pipeline.summarizeVideo(WEB_URL);

    // extract → transcribe reuse 'transcription'; the summary step uses 'agent'.
    expect(harness.accounting.grants.map((grant) => grant.kind)).toEqual(['transcription', 'transcription', 'agent']);
    assertBalanced(harness.accounting);
  });

  it('light DOM reads (readText, readAccessibilityTree) acquire zero leases', async () => {
    const harness = createHarness();

    await harness.perception.readText('tab-1');
    await harness.perception.readAccessibilityTree('tab-1');

    expect(harness.accounting.grants).toEqual([]);
    expect(harness.accounting.releases).toEqual([]);
  });

  it('releases the browser lease even when capturePage throws', async () => {
    const harness = createHarness('capture');

    await expect(harness.perception.capture('tab-1')).rejects.toThrow(/injected:capture/);

    expect(harness.accounting.grants.map((grant) => grant.kind)).toEqual(['browser']);
    assertBalanced(harness.accounting);
  });

  it('acquires no lease when capture targets an unknown tab (fails before leasing)', async () => {
    const harness = createHarness();

    await expect(harness.perception.capture('missing')).rejects.toThrow(/No web contents/);

    expect(harness.accounting.grants).toEqual([]);
    assertBalanced(harness.accounting);
  });

  it('releases both heavy leases taken before a mid-pipeline transcribe failure', async () => {
    const harness = createHarness('transcribe');

    await expect(harness.pipeline.dub(WEB_URL)).rejects.toThrow(/injected:transcribe/);

    // extract leased + released, transcribe leased + released via finally; then it stops.
    expect(harness.accounting.grants.map((grant) => grant.kind)).toEqual(['transcription', 'transcription']);
    assertBalanced(harness.accounting);
  });
});
