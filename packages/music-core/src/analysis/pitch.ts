/**
 * Monophonic pitch detection via the YIN algorithm (de Cheveigné & Kawahara, 2002).
 *
 * This is part of the agent's "ears": given raw audio samples, return the
 * fundamental frequency in Hz. Pure DSP — no Web Audio, no Node. Works on a
 * single analysis frame (a window of samples at a known sample rate).
 *
 * YIN steps: difference function → cumulative mean normalized difference →
 * absolute threshold → parabolic interpolation around the chosen lag.
 */

export type PitchResult = {
  /** Estimated fundamental frequency in Hz, or null if unpitched/too quiet. */
  hz: number | null;
  /** Confidence in [0..1] (1 - YIN dip value at the chosen lag). */
  confidence: number;
};

const DEFAULT_THRESHOLD = 0.15;

/**
 * Detect pitch in a single frame.
 * @param samples mono PCM, ideally a power-of-two length (e.g. 2048).
 * @param sampleRate Hz (e.g. 44100, 48000).
 * @param threshold YIN absolute threshold (lower = stricter).
 */
export function detectPitch(samples: Float32Array, sampleRate: number, threshold = DEFAULT_THRESHOLD): PitchResult {
  const n = samples.length;
  const maxTau = Math.floor(n / 2);
  if (maxTau < 2) return { hz: null, confidence: 0 };

  // 1. Difference function d(tau).
  const diff = new Float32Array(maxTau);
  for (let tau = 1; tau < maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < maxTau; i++) {
      const delta = samples[i] - samples[i + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  // 2. Cumulative mean normalized difference d'(tau).
  const cmnd = new Float32Array(maxTau);
  cmnd[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < maxTau; tau++) {
    runningSum += diff[tau];
    cmnd[tau] = runningSum > 0 ? (diff[tau] * tau) / runningSum : 1;
  }

  // 3. Absolute threshold: first local minimum below threshold.
  let tauEstimate = -1;
  for (let tau = 2; tau < maxTau; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 < maxTau && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }
  // Fallback: take the global minimum if nothing crossed the threshold.
  if (tauEstimate === -1) {
    let minValue = cmnd[2];
    let minTau = 2;
    for (let tau = 3; tau < maxTau; tau++) {
      if (cmnd[tau] < minValue) {
        minValue = cmnd[tau];
        minTau = tau;
      }
    }
    if (minValue >= 0.5) return { hz: null, confidence: 0 };
    tauEstimate = minTau;
  }

  // 4. Parabolic interpolation for sub-sample accuracy.
  const betterTau = parabolicInterpolation(cmnd, tauEstimate);
  if (betterTau <= 0) return { hz: null, confidence: 0 };

  const hz = sampleRate / betterTau;
  const confidence = Math.max(0, Math.min(1, 1 - cmnd[tauEstimate]));
  return { hz, confidence };
}

function parabolicInterpolation(array: Float32Array, tau: number): number {
  const x0 = tau > 0 ? tau - 1 : tau;
  const x2 = tau + 1 < array.length ? tau + 1 : tau;
  if (x0 === tau) return array[tau] <= array[x2] ? tau : x2;
  if (x2 === tau) return array[tau] <= array[x0] ? tau : x0;

  const s0 = array[x0];
  const s1 = array[tau];
  const s2 = array[x2];
  const denom = 2 * (2 * s1 - s2 - s0);
  if (denom === 0) return tau;
  return tau + (s2 - s0) / denom;
}

const A4_HZ = 440;
const A4_MIDI = 69;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Convert a frequency to a fractional MIDI note number. */
export function hzToMidi(hz: number): number {
  return A4_MIDI + 12 * Math.log2(hz / A4_HZ);
}

/** Convert a MIDI note number to frequency. */
export function midiToHz(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** Human-readable note name, e.g. 440 → "A4". */
export function hzToNoteName(hz: number): string {
  const midi = Math.round(hzToMidi(hz));
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

/** Cents deviation from the nearest equal-tempered note (-50..+50). */
export function centsOffPitch(hz: number): number {
  const midi = hzToMidi(hz);
  return Math.round((midi - Math.round(midi)) * 100);
}
