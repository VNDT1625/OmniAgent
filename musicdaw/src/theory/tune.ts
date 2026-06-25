/**
 * Vocal pitch-correction PLANNING (key-aware autotune logic).
 *
 * This computes WHAT correction to apply: for each analyzed pitch frame, find
 * the nearest in-key note and the cents shift needed to reach it, scaled by a
 * strength amount. The actual pitch-SHIFTING of audio (Fourier/PSOLA) happens
 * in the renderer via WASM (autotone-style) or the Rust sidecar — this module
 * stays pure so the agent and tests can reason about tuning decisions.
 */

import { hzToMidi, midiToHz } from '../analysis/pitch';
import { snapMidiToKey } from './theory';
import type { Scale } from './theory';

export type PitchFrame = {
  timeSec: number;
  hz: number | null;
  confidence: number;
};

export type TuneCorrection = {
  timeSec: number;
  /** Original detected frequency. */
  fromHz: number;
  /** Target frequency after snapping to key + strength. */
  toHz: number;
  /** Cents shift to apply (positive = up). */
  centsShift: number;
};

export type TuneOptions = {
  tonic: number; // 0..11
  scale: Scale;
  /** 0..100; 100 = fully snap to target, 0 = no change. */
  strengthPct: number;
  /** Ignore frames below this detection confidence. */
  minConfidence?: number;
};

const DEFAULT_MIN_CONF = 0.5;

/** Compute the correction for a single detected frequency. */
export function correctFrequency(
  hz: number,
  tonic: number,
  scale: Scale,
  strengthPct: number
): { toHz: number; centsShift: number } {
  const midi = hzToMidi(hz);
  const targetMidi = snapMidiToKey(Math.round(midi), tonic, scale);
  const targetHz = midiToHz(targetMidi);

  // Full cents distance from current pitch to the target note.
  const fullCents = 1200 * Math.log2(targetHz / hz);
  const strength = Math.max(0, Math.min(1, strengthPct / 100));
  const centsShift = fullCents * strength;

  // Apply partial shift: new pitch is current * 2^(cents/1200).
  const toHz = hz * Math.pow(2, centsShift / 1200);
  return { toHz, centsShift };
}

/**
 * Plan corrections across a pitch track. Returns one correction per voiced,
 * confident frame. Unvoiced/low-confidence frames are skipped (left untouched).
 */
export function planTune(frames: PitchFrame[], options: TuneOptions): TuneCorrection[] {
  const minConf = options.minConfidence ?? DEFAULT_MIN_CONF;
  const out: TuneCorrection[] = [];
  for (const frame of frames) {
    if (frame.hz === null || frame.confidence < minConf) continue;
    const { toHz, centsShift } = correctFrequency(frame.hz, options.tonic, options.scale, options.strengthPct);
    out.push({ timeSec: frame.timeSec, fromHz: frame.hz, toHz, centsShift });
  }
  return out;
}

/** Average absolute cents the tuner moved pitches — a measure of how off-key the take was. */
export function meanAbsCentsShift(corrections: TuneCorrection[]): number {
  if (corrections.length === 0) return 0;
  const sum = corrections.reduce((acc, c) => acc + Math.abs(c.centsShift), 0);
  return sum / corrections.length;
}
