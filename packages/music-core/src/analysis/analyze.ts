/**
 * Analysis facade — the agent's single "listen" entry point.
 *
 * Given raw mono audio, produce a structured musical summary the agent can act
 * on: detected pitch (for monophonic material), key/scale, tempo, and the
 * chroma vector. This is what lets the agent behave like a producer who
 * actually *heard* the audio rather than guessing from metadata.
 */

import { computeChroma } from './chroma';
import { detectKey } from './key';
import type { KeyResult } from './key';
import { centsOffPitch, detectPitch, hzToNoteName } from './pitch';
import { detectTempo } from './tempo';

export type AudioAnalysis = {
  sampleRate: number;
  durationSec: number;
  /** Dominant pitch over the analyzed window (monophonic estimate). */
  pitch: { hz: number | null; note: string | null; cents: number | null; confidence: number };
  key: KeyResult;
  tempo: { bpm: number | null; confidence: number };
  chroma: number[];
};

export type AnalyzeOptions = {
  /** Frame size for pitch analysis (time-domain YIN). */
  frameSize?: number;
  /**
   * Frame size for chroma/key analysis. Larger than the pitch frame because
   * frequency-domain resolution matters for key detection, especially for
   * low notes (a 2048 frame at 44.1k only resolves ~21Hz per bin).
   */
  chromaFrameSize?: number;
};

const DEFAULT_FRAME = 2048;
const DEFAULT_CHROMA_FRAME = 8192;

/**
 * Analyze a mono audio buffer end to end.
 * Pitch is detected over short frames; chroma/key use longer frames for
 * frequency resolution; tempo uses the whole signal.
 */
export function analyzeAudio(samples: Float32Array, sampleRate: number, options: AnalyzeOptions = {}): AudioAnalysis {
  const frameSize = options.frameSize ?? DEFAULT_FRAME;
  const chromaFrameSize = options.chromaFrameSize ?? DEFAULT_CHROMA_FRAME;
  const durationSec = samples.length / sampleRate;

  // Pitch: detect over a few short frames (sampled across the signal) and keep
  // the highest-confidence estimate. Capped so long audio stays fast.
  let bestPitchHz: number | null = null;
  let bestPitchConf = 0;
  const MAX_PITCH_FRAMES = 16;
  const pitchFrameCount = Math.max(1, Math.floor(samples.length / frameSize));
  const pitchStride = Math.max(1, Math.floor(pitchFrameCount / MAX_PITCH_FRAMES));
  for (let f = 0; f < pitchFrameCount; f += pitchStride) {
    const start = f * frameSize;
    if (start + frameSize > samples.length) break;
    const p = detectPitch(samples.subarray(start, start + frameSize), sampleRate);
    if (p.hz !== null && p.confidence > bestPitchConf) {
      bestPitchConf = p.confidence;
      bestPitchHz = p.hz;
    }
  }

  // Chroma: longer frames for frequency resolution. Cap the number of frames
  // analyzed (sampling across the signal) so long audio stays fast — the naive
  // DFT is O(n·bins), and a handful of frames is plenty for key detection.
  const chromaFrames: number[][] = [];
  const effectiveChromaFrame = Math.min(chromaFrameSize, samples.length);
  const MAX_CHROMA_FRAMES = 8;
  const totalFrames = Math.max(1, Math.floor(samples.length / effectiveChromaFrame));
  const stride = Math.max(1, Math.floor(totalFrames / MAX_CHROMA_FRAMES));
  for (let f = 0; f < totalFrames; f += stride) {
    const start = f * effectiveChromaFrame;
    if (start + effectiveChromaFrame > samples.length) break;
    chromaFrames.push(computeChroma(samples.subarray(start, start + effectiveChromaFrame), sampleRate));
  }

  // Fallbacks for very short signals.
  if (bestPitchHz === null && samples.length > 0) {
    const p = detectPitch(samples, sampleRate);
    bestPitchHz = p.hz;
    bestPitchConf = p.confidence;
  }
  if (chromaFrames.length === 0 && samples.length > 0) {
    chromaFrames.push(computeChroma(samples, sampleRate));
  }

  const chroma = averageFrames(chromaFrames);
  const key = detectKey(chroma);
  const tempo = detectTempo(samples, sampleRate);

  return {
    sampleRate,
    durationSec,
    pitch: {
      hz: bestPitchHz,
      note: bestPitchHz !== null ? hzToNoteName(bestPitchHz) : null,
      cents: bestPitchHz !== null ? centsOffPitch(bestPitchHz) : null,
      confidence: bestPitchConf,
    },
    key,
    tempo,
    chroma,
  };
}

function averageFrames(frames: number[][]): number[] {
  if (frames.length === 0) return Array.from({ length: 12 }, () => 0);
  const sum = Array.from({ length: 12 }, () => 0);
  for (const f of frames) {
    for (let i = 0; i < 12; i++) sum[i] += f[i];
  }
  const total = sum.reduce((a, b) => a + b, 0);
  if (total <= 0) return sum.map(() => 0);
  return sum.map((v) => v / total);
}
