/**
 * Factory helpers to create well-formed schema objects with sane defaults.
 * Keeping construction centralized avoids drift between features.
 */

import { newId } from './ids';
import { CURRENT_SCHEMA_VERSION } from './schema';
import type { Clip, Effect, EffectKind, Project, Sample, Track, TrackType } from './schema';

const DEFAULT_TEMPO = 120;
const DEFAULT_SAMPLE_RATE = 48000;

const TRACK_COLORS = ['#8B5CF6', '#EC4899', '#F59E0B', '#10B981', '#3B82F6', '#EF4444'];

export function createProject(name = 'Untitled'): Project {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: newId(),
    name,
    tempo: DEFAULT_TEMPO,
    timeSignature: [4, 4],
    sampleRate: DEFAULT_SAMPLE_RATE,
    master: { volumeDb: 0, pan: 0, effects: [] },
    tracks: [],
    samples: [],
  };
}

export function createTrack(name: string, type: TrackType = 'instrument', colorIndex = 0): Track {
  return {
    id: newId(),
    name,
    type,
    color: TRACK_COLORS[colorIndex % TRACK_COLORS.length],
    mute: false,
    solo: false,
    armed: false,
    volumeDb: 0,
    pan: 0,
    instrument: type === 'instrument' ? { kind: 'sampler', sampleId: null } : null,
    effects: [],
    clips: [],
  };
}

const DEFAULT_EFFECT_PARAMS: Record<EffectKind, Record<string, number>> = {
  eq3: { low: 0, mid: 0, high: 0 },
  compressor: { thresholdDb: -24, ratio: 4, attackMs: 3, releaseMs: 250 },
  reverb: { decaySec: 1.5, wet: 0.3 },
  delay: { timeSec: 0.25, feedback: 0.3, wet: 0.3 },
};

export function createEffect(kind: EffectKind): Effect {
  return {
    id: newId(),
    kind,
    bypass: false,
    params: { ...DEFAULT_EFFECT_PARAMS[kind] },
  };
}

export function createPatternClip(startBeat: number, lengthBeat: number): Clip {
  return { id: newId(), startBeat, lengthBeat, kind: 'pattern', steps: [] };
}

export function createSample(
  file: string,
  name: string,
  durationSec: number,
  sampleRate = DEFAULT_SAMPLE_RATE
): Sample {
  return { id: newId(), file, name, durationSec, sampleRate };
}
