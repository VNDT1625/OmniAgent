/**
 * Producer brain — the agent's decision layer.
 *
 * This is where "hearing" meets "doing": the agent analyzes audio, reasons in
 * the detected key, and emits concrete engine commands or musical suggestions.
 * It is pure and headless, so it powers both autonomous agent actions (via MCP
 * later) and "assist" buttons in the UI. It never touches audio devices.
 *
 * Design: functions return descriptions/plans (data), or apply changes via the
 * engine commands and return a new Project. The caller decides persistence.
 */

import { analyzeAudio } from '../analysis/analyze';
import type { AudioAnalysis } from '../analysis/analyze';
import { addNote, setTempo } from '../core/engine';
import { buildChord, diatonicChords, suggestProgression } from '../theory/theory';
import type { Chord, Scale } from '../theory/theory';
import type { Note, Project } from '../shared/schema';

export type MusicalAssessment = {
  analysis: AudioAnalysis;
  keyName: string;
  tonic: number;
  scale: Scale;
  tempoBpm: number | null;
  /** Chords that fit the detected key. */
  diatonic: Chord[];
  /** A ready-to-use progression in the detected key. */
  suggestedProgression: Chord[];
  /** Plain-language notes for the agent to explain its reasoning. */
  remarks: string[];
};

/**
 * Listen to audio and produce a full musical assessment the agent can act on.
 * This is the agent's "I actually heard it" step.
 */
export function assess(samples: Float32Array, sampleRate: number): MusicalAssessment {
  const analysis = analyzeAudio(samples, sampleRate);
  const { tonic, scale, name } = analysis.key;
  const remarks: string[] = [];

  remarks.push(`Heard key ${name} (confidence ${analysis.key.correlation.toFixed(2)}).`);
  if (analysis.tempo.bpm !== null) {
    remarks.push(`Tempo ~${analysis.tempo.bpm} BPM (confidence ${analysis.tempo.confidence.toFixed(2)}).`);
  } else {
    remarks.push('No clear tempo detected (sparse or sustained material).');
  }
  if (analysis.pitch.note) {
    remarks.push(
      `Dominant pitch ${analysis.pitch.note}${analysis.pitch.cents ? ` (${analysis.pitch.cents > 0 ? '+' : ''}${analysis.pitch.cents}c)` : ''}.`
    );
  }

  return {
    analysis,
    keyName: name,
    tonic,
    scale,
    tempoBpm: analysis.tempo.bpm,
    diatonic: diatonicChords(tonic, scale),
    suggestedProgression: suggestProgression(tonic, scale),
    remarks,
  };
}

/**
 * Match the project tempo to what the agent heard in a reference audio clip.
 * Returns the (possibly) updated project + whether it changed.
 */
export function matchTempoToAudio(
  project: Project,
  samples: Float32Array,
  sampleRate: number
): { project: Project; bpm: number | null } {
  const { tempo } = analyzeAudio(samples, sampleRate);
  if (tempo.bpm === null || tempo.confidence < 0.3) return { project, bpm: null };
  return { project: setTempo(project, tempo.bpm), bpm: tempo.bpm };
}

/**
 * Lay a chord progression into a MIDI clip as block chords, in the given key.
 * The agent uses this to "comp" chords after hearing the key. One chord per bar.
 */
export function layProgression(
  project: Project,
  trackId: string,
  clipId: string,
  progression: Chord[],
  options: { octave?: number; beatsPerChord?: number; velocity?: number } = {}
): Project {
  const octave = options.octave ?? 4;
  const beatsPerChord = options.beatsPerChord ?? 4;
  const velocity = options.velocity ?? 90;

  let next = project;
  progression.forEach((chord, index) => {
    const startBeat = index * beatsPerChord;
    for (const pc of chord.pitchClasses) {
      const midi = (octave + 1) * 12 + pc; // MIDI octave convention: C4 = 60
      const note: Note = { pitch: midi, startBeat, lengthBeat: beatsPerChord, velocity };
      next = addNote(next, trackId, clipId, note);
    }
  });
  return next;
}

/** Convenience: build a named chord (e.g. for tool output). */
export function describeChord(rootPc: number, quality: Parameters<typeof buildChord>[1]): Chord {
  return buildChord(rootPc, quality);
}
