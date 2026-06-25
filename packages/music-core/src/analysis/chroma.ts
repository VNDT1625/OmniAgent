/**
 * Chroma (pitch-class profile) extraction.
 *
 * Part of the agent's "ears": compute a 12-bin energy histogram (one bin per
 * pitch class C..B) from audio. Built on a small real-input DFT magnitude
 * spectrum so it stays dependency-free and testable with synthetic tones.
 *
 * For full songs you would frame + average; here we expose both a single-frame
 * chroma and a helper to accumulate across frames.
 */

const A4_HZ = 440;

/**
 * Naive DFT magnitude spectrum for the first `bins` frequency bins.
 * O(n * bins) — fine for analysis frames (n ~ 2048, bins ~ 1024). Kept simple
 * and dependency-free; swap for FFT later if profiling demands it.
 */
export function magnitudeSpectrum(samples: Float32Array, bins: number): Float32Array {
  const n = samples.length;
  const out = new Float32Array(bins);
  for (let k = 0; k < bins; k++) {
    let re = 0;
    let im = 0;
    const w = (-2 * Math.PI * k) / n;
    for (let i = 0; i < n; i++) {
      const angle = w * i;
      re += samples[i] * Math.cos(angle);
      im += samples[i] * Math.sin(angle);
    }
    out[k] = Math.sqrt(re * re + im * im);
  }
  return out;
}

/** Map a frequency to a pitch class 0..11, or -1 if out of musical range. */
export function hzToPitchClass(hz: number): number {
  if (hz <= 0) return -1;
  const midi = 69 + 12 * Math.log2(hz / A4_HZ);
  if (midi < 0 || midi > 127) return -1;
  return ((Math.round(midi) % 12) + 12) % 12;
}

/**
 * Single-frame chroma: accumulate spectral energy into 12 pitch-class bins.
 * Returns a normalized 12-length vector (sums to 1, or all-zero if silent).
 *
 * Only frequency bins up to ~5kHz are computed: musical pitch classes live well
 * below that (C8 ≈ 4186Hz), and the naive DFT is O(n·bins), so capping the bin
 * count keeps analysis fast on long windows instead of computing all n/2 bins.
 */
export function computeChroma(samples: Float32Array, sampleRate: number): number[] {
  const MAX_FREQ_HZ = 5000;
  const nyquistBins = Math.floor(samples.length / 2);
  const freqCappedBins = Math.ceil((MAX_FREQ_HZ * samples.length) / sampleRate) + 1;
  const bins = Math.min(nyquistBins, freqCappedBins);
  const spectrum = magnitudeSpectrum(samples, bins);
  const chroma = new Array<number>(12).fill(0);

  for (let k = 1; k < bins; k++) {
    const hz = (k * sampleRate) / samples.length;
    const pc = hzToPitchClass(hz);
    if (pc >= 0) chroma[pc] += spectrum[k];
  }

  return normalize(chroma);
}

/** Average several per-frame chroma vectors into one, then normalize. */
export function averageChroma(frames: number[][]): number[] {
  if (frames.length === 0) return new Array<number>(12).fill(0);
  const sum = new Array<number>(12).fill(0);
  for (const frame of frames) {
    for (let i = 0; i < 12; i++) sum[i] += frame[i];
  }
  return normalize(sum);
}

function normalize(vector: number[]): number[] {
  const total = vector.reduce((acc, v) => acc + v, 0);
  if (total <= 0) return vector.map(() => 0);
  return vector.map((v) => v / total);
}
