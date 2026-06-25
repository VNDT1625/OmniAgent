/**
 * MusicDAW project schema (v1).
 *
 * Single source of truth for a project. Replaces the Supabase data model from
 * the beets base. Every feature (playback, mixing, export, vocal tune) reads
 * and writes from this structure. Persisted as `project.json` inside a
 * `<Name>.daw/` folder alongside `samples/` and `renders/`.
 *
 * Pure data + types only. No Node.js or DOM APIs here so it can be imported by
 * both the Electron main process and the renderer.
 */

export const CURRENT_SCHEMA_VERSION = 1 as const;

export type TrackType = 'instrument' | 'audio' | 'midi';
export type ClipKind = 'pattern' | 'midi' | 'audio';

export type EffectKind = 'eq3' | 'compressor' | 'reverb' | 'delay';

export type Effect = {
  id: string;
  kind: EffectKind;
  bypass: boolean;
  /** Free-form, validated per-kind by the engine layer. */
  params: Record<string, number>;
};

export type InstrumentKind = 'sampler' | 'synth';

export type Instrument = {
  kind: InstrumentKind;
  /** For "sampler": references a Sample.id. Null for synth presets. */
  sampleId: string | null;
};

/** A single step in a step-sequencer pattern clip. */
export type Step = {
  step: number;
  sampleId: string | null;
  velocity: number; // 0..127
};

/** A MIDI/piano-roll note inside a clip. */
export type Note = {
  pitch: number; // MIDI note number 0..127
  startBeat: number;
  lengthBeat: number;
  velocity: number; // 0..127
};

/** Pitch-correction settings applied (offline) to an audio clip. */
export type TuneSettings = {
  keyRoot: number; // 0..11 (C=0)
  scale: 'major' | 'minor' | 'chromatic';
  strengthPct: number; // 0..100
};

export type AudioClipData = {
  sampleId: string;
  offsetSec: number;
  gainDb: number;
  tune: TuneSettings | null;
};

export type Clip = {
  id: string;
  startBeat: number;
  lengthBeat: number;
  kind: ClipKind;
  /** Present when kind === 'pattern'. */
  steps?: Step[];
  /** Present when kind === 'midi'. */
  notes?: Note[];
  /** Present when kind === 'audio'. */
  audio?: AudioClipData;
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
  pan: number; // -1..1
  instrument: Instrument | null;
  effects: Effect[];
  clips: Clip[];
};

export type Sample = {
  id: string;
  /** Path relative to the project folder, e.g. "samples/kick.wav". */
  file: string;
  name: string;
  durationSec: number;
  sampleRate: number;
};

export type MasterBus = {
  volumeDb: number;
  pan: number;
  effects: Effect[];
};

export type Project = {
  schemaVersion: number;
  id: string;
  name: string;
  tempo: number;
  timeSignature: [number, number];
  sampleRate: number;
  master: MasterBus;
  tracks: Track[];
  samples: Sample[];
};
