/**
 * Tempo (BPM) estimation via onset-energy envelope + autocorrelation.
 *
 * Part of the agent's "ears": find the dominant periodicity of energy spikes
 * (note onsets) and convert it to beats per minute. Pure DSP over mono samples.
 *
 * Pipeline: frame the signal → RMS energy per frame → half-wave-rectified
 * energy difference (onset strength) → autocorrelation → pick the lag with the
 * strongest periodicity within a musical BPM range.
 */

export type TempoResult = {
  /** Estimated tempo in BPM, or null if no clear periodicity. */
  bpm: number | null;
  /** Confidence in [0..1] from the normalized autocorrelation peak. */
  confidence: number;
};

const DEFAULT_HOP = 512;
const MIN_BPM = 60;
const MAX_BPM = 200;

/**
 * Estimate tempo.
 * @param samples mono PCM.
 * @param sampleRate Hz.
 * @param hop frame hop size in samples (frame rate = sampleRate / hop).
 */
export function detectTempo(samples: Float32Array, sampleRate: number, hop = DEFAULT_HOP): TempoResult {
  const onset = onsetEnvelope(samples, hop);
  if (onset.length < 4) return { bpm: null, confidence: 0 };

  const frameRate = sampleRate / hop; // frames per second
  const minLag = Math.max(1, Math.floor((frameRate * 60) / MAX_BPM));
  const maxLag = Math.floor((frameRate * 60) / MIN_BPM);
  if (maxLag <= minLag) return { bpm: null, confidence: 0 };

  // Autocorrelation of the onset envelope across candidate lags.
  let bestLag = -1;
  let bestScore = 0;
  const zeroLag = autocorrelate(onset, 0);
  for (let lag = minLag; lag <= maxLag && lag < onset.length; lag++) {
    const score = autocorrelate(onset, lag);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (bestLag <= 0) return { bpm: null, confidence: 0 };
  const bpm = (frameRate * 60) / bestLag;
  const confidence = zeroLag > 0 ? Math.max(0, Math.min(1, bestScore / zeroLag)) : 0;
  return { bpm: Math.round(bpm * 10) / 10, confidence };
}

/** Half-wave-rectified energy-difference envelope (onset strength per frame). */
export function onsetEnvelope(samples: Float32Array, hop: number): Float32Array {
  const frameCount = Math.floor(samples.length / hop);
  if (frameCount < 2) return new Float32Array(0);

  const energy = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = 0; i < hop; i++) {
      const s = samples[start + i];
      sum += s * s;
    }
    energy[f] = Math.sqrt(sum / hop);
  }

  // Onset strength = positive change in energy between consecutive frames.
  const onset = new Float32Array(frameCount - 1);
  for (let f = 1; f < frameCount; f++) {
    const diff = energy[f] - energy[f - 1];
    onset[f - 1] = diff > 0 ? diff : 0;
  }
  return onset;
}

function autocorrelate(signal: Float32Array, lag: number): number {
  let sum = 0;
  for (let i = 0; i + lag < signal.length; i++) {
    sum += signal[i] * signal[i + lag];
  }
  return sum;
}
