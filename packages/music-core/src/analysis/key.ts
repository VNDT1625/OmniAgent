/**
 * Key detection via the Krumhansl-Schmuckler key-finding algorithm.
 *
 * Part of the agent's "ears": given a chroma vector (12-bin pitch-class energy),
 * correlate it against major/minor key profiles and return the best-matching
 * key. This lets the agent reason in the song's actual key instead of guessing.
 *
 * Pure math — feed it a chroma vector from `chroma.ts`.
 */

const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export type Scale = 'major' | 'minor';

export type KeyResult = {
  /** Tonic pitch class 0..11 (C=0). */
  tonic: number;
  /** "major" or "minor". */
  scale: Scale;
  /** Human-readable, e.g. "A minor". */
  name: string;
  /** Pearson correlation of the winning key in [-1..1]. */
  correlation: number;
};

// Krumhansl-Kessler key profiles (relative weights per scale degree).
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function rotate(profile: number[], steps: number): number[] {
  const n = profile.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = profile[(i - steps + n) % n];
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? 0 : num / denom;
}

/**
 * Detect key from a 12-bin chroma vector.
 * Tries all 12 major and 12 minor rotations, returns the best correlation.
 */
export function detectKey(chroma: number[]): KeyResult {
  if (chroma.length !== 12) throw new Error('chroma must have 12 bins');

  let best: KeyResult = { tonic: 0, scale: 'major', name: 'C major', correlation: -Infinity };

  for (let tonic = 0; tonic < 12; tonic++) {
    const major = pearson(chroma, rotate(MAJOR_PROFILE, tonic));
    if (major > best.correlation) {
      best = { tonic, scale: 'major', name: `${PITCH_CLASSES[tonic]} major`, correlation: major };
    }
    const minor = pearson(chroma, rotate(MINOR_PROFILE, tonic));
    if (minor > best.correlation) {
      best = { tonic, scale: 'minor', name: `${PITCH_CLASSES[tonic]} minor`, correlation: minor };
    }
  }

  return best;
}

export function pitchClassName(pc: number): string {
  return PITCH_CLASSES[((pc % 12) + 12) % 12];
}
