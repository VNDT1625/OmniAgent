/**
 * Project file schema (v1) — the single source of truth for the DAW.
 *
 * Every feature (playback, mixing, export, vocal tuning) reads from / writes to
 * this schema. It replaces the Supabase data model used by the upstream `beets`
 * base. A project on disk is a folder:
 *
 *   MySong.daw/
 *     project.json   <- serialized ProjectSchema
 *     samples/       <- imported / recorded audio
 *     renders/       <- export output
 *
 * Shared between the Electron main process and the renderer, so it must not use
 * Node.js or DOM APIs. IDs use the global Web Crypto `crypto.randomUUID()`,
 * available both in Node >= 19 and in the renderer.
 */

export const CURRENT_SCHEMA_VERSION = 1;

export type TrackType = 'instrument' | 'audio' | 'midi';
export type ClipKind = 'pattern' | 'midi' | 'audio';
export type InstrumentKind = 'sampler' | 'synth';

export type EffectKind = 'eq3' | 'compressor' | 'reverb' | 'delay';

export type Effect = {
  id: string;
  kind: EffectKind;
  bypass: boolean;
  params: Record<string, number>;
};

export type StepEvent = {
  step: number;
  sampleId: string;
  velocity: number;
};

export type NoteEvent = {
  pitch: number; // MIDI note number 0-127
  startBeat: number;
  lengthBeat: number;
  velocity: number;
};

export type ClipAudio = {
  sampleId: string;
  offsetSec: number;
  gainDb: number;
  /** Vocal-tune settings applied to this clip, or null when untuned. */
  tune: TuneSettings | null;
};

export type TuneSettings = {
  keyRoot: number; // 0-11, C=0
  scale: 'major' | 'minor' | 'chromatic';
  strengthPct: number; // 0-100
};

export type Clip = {
  id: string;
  startBeat: number;
  lengthBeat: number;
  kind: ClipKind;
  steps?: StepEvent[];
  notes?: NoteEvent[];
  audio?: ClipAudio;
};

export type Instrument = {
  kind: InstrumentKind;
  sampleId?: string;
};

export type Track = {
  id: string;
  name: string;
  type: TrackType;
  color: string;
  mute: boolean;
  solo: boolean;
  armed: boolean;
  volumeDb: number;
  pan: number; // -1 .. 1
  instrument?: Instrument;
  effects: Effect[];
  clips: Clip[];
};

export type MasterBus = {
  volumeDb: number;
  pan: number;
  effects: Effect[];
};

export type SampleRef = {
  id: string;
  /** Path relative to the project folder, e.g. "samples/kick.wav". */
  file: string;
  name: string;
  durationSec: number;
  sampleRate: number;
};

export type ProjectSchema = {
  schemaVersion: number;
  id: string;
  name: string;
  tempo: number;
  timeSignature: [number, number];
  sampleRate: number;
  master: MasterBus;
  tracks: Track[];
  samples: SampleRef[];
};

const newId = (): string => crypto.randomUUID();

export const createMasterBus = (): MasterBus => ({
  volumeDb: 0,
  pan: 0,
  effects: [],
});

export const createProjectSchema = (name: string): ProjectSchema => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  id: newId(),
  name,
  tempo: 120,
  timeSignature: [4, 4],
  sampleRate: 48000,
  master: createMasterBus(),
  tracks: [],
  samples: [],
});

export const createTrack = (name: string, type: TrackType = 'instrument'): Track => ({
  id: newId(),
  name,
  type,
  color: '#8B5CF6',
  mute: false,
  solo: false,
  armed: false,
  volumeDb: 0,
  pan: 0,
  effects: [],
  clips: [],
});

export const createSampleRef = (file: string, name: string): SampleRef => ({
  id: newId(),
  file,
  name,
  durationSec: 0,
  sampleRate: 48000,
});
