/**
 * Actionable music theory — the "producer brain" that turns what the agent
 * HEARS (key, pitch) into musical decisions: which notes belong to the key,
 * which chords fit, and snapping an off pitch to the nearest in-key note.
 *
 * Pure functions over pitch classes (0..11) and MIDI numbers. No audio here;
 * this layer reasons about notes. Feeds vocal tuning and chord suggestion.
 */

export type Scale = 'major' | 'minor';

const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

// Semitone intervals from the tonic.
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const NATURAL_MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

// Diatonic triad qualities per scale degree.
const MAJOR_TRIAD_QUALITIES = ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'] as const;
const MINOR_TRIAD_QUALITIES = ['min', 'dim', 'maj', 'min', 'min', 'maj', 'maj'] as const;

export type ChordQuality = 'maj' | 'min' | 'dim' | 'aug';

export type Chord = {
  /** Root pitch class 0..11. */
  root: number;
  quality: ChordQuality;
  /** Pitch classes that make up the chord. */
  pitchClasses: number[];
  /** Human-readable, e.g. "Am", "C", "G". */
  name: string;
};

export function pitchClassName(pc: number): string {
  return PITCH_CLASSES[((pc % 12) + 12) % 12];
}

export function scaleSteps(scale: Scale): number[] {
  return scale === 'major' ? MAJOR_STEPS : NATURAL_MINOR_STEPS;
}

/** The 7 pitch classes of a key. */
export function scalePitchClasses(tonic: number, scale: Scale): number[] {
  return scaleSteps(scale).map((s) => (tonic + s) % 12);
}

/** True if a pitch class belongs to the key. */
export function isInKey(pitchClass: number, tonic: number, scale: Scale): boolean {
  return scalePitchClasses(tonic, scale).includes(((pitchClass % 12) + 12) % 12);
}

const TRIAD_INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
};

export function buildChord(root: number, quality: ChordQuality): Chord {
  const pcs = TRIAD_INTERVALS[quality].map((i) => (root + i) % 12);
  const suffix = quality === 'maj' ? '' : quality === 'min' ? 'm' : quality;
  return { root: ((root % 12) + 12) % 12, quality, pitchClasses: pcs, name: `${pitchClassName(root)}${suffix}` };
}

/** The 7 diatonic triads of a key, by scale degree (I..vii). */
export function diatonicChords(tonic: number, scale: Scale): Chord[] {
  const pcs = scalePitchClasses(tonic, scale);
  const qualities = scale === 'major' ? MAJOR_TRIAD_QUALITIES : MINOR_TRIAD_QUALITIES;
  return pcs.map((root, degree) => buildChord(root, qualities[degree]));
}

/**
 * Snap a MIDI note to the nearest note that belongs to the key.
 * Ties resolve downward (toward the lower pitch).
 */
export function snapMidiToKey(midi: number, tonic: number, scale: Scale): number {
  const inKey = scalePitchClasses(tonic, scale);
  let best = midi;
  let bestDist = Infinity;
  for (let candidate = midi - 6; candidate <= midi + 6; candidate++) {
    const pc = ((candidate % 12) + 12) % 12;
    if (!inKey.includes(pc)) continue;
    const dist = Math.abs(candidate - midi);
    if (dist < bestDist || (dist === bestDist && candidate < best)) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

/**
 * Suggest a common chord progression for a key as scale-degree indices.
 * Returns concrete chords. Defaults to a I–V–vi–IV (major) / i–VI–III–VII
 * (minor) style that works for pop/lofi.
 */
export function suggestProgression(tonic: number, scale: Scale): Chord[] {
  const chords = diatonicChords(tonic, scale);
  const degrees = scale === 'major' ? [0, 4, 5, 3] : [0, 5, 2, 6];
  return degrees.map((d) => chords[d]);
}
