/**
 * Built-in synthetic instruments — so projects make sound without external
 * sample files. Pure DSP returning AudioBuffers; used by the CLI/demo render
 * path and as default sampler sounds. The renderer can swap these for loaded
 * WAVs later.
 */

import type { AudioBuffer } from './wav';
import type { SampleBank } from './render';

/** Punchy kick: pitch-dropping sine with a fast amplitude decay. */
export function synthKick(sampleRate = 44100): AudioBuffer {
  const dur = 0.18;
  const n = Math.floor(dur * sampleRate);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const freq = 120 * Math.exp(-t * 30) + 45;
    samples[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 18);
  }
  return { sampleRate, samples };
}

/** Snare: noise body + a tonal "crack". */
export function synthSnare(sampleRate = 44100): AudioBuffer {
  const dur = 0.2;
  const n = Math.floor(dur * sampleRate);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const noise = (Math.random() * 2 - 1) * Math.exp(-t * 22);
    const tone = Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 30) * 0.5;
    samples[i] = (noise * 0.8 + tone) * 0.8;
  }
  return { sampleRate, samples };
}

/** Hihat: short high-passed noise burst. */
export function synthHat(sampleRate = 44100): AudioBuffer {
  const dur = 0.05;
  const n = Math.floor(dur * sampleRate);
  const samples = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const noise = Math.random() * 2 - 1;
    const hp = noise - prev; // crude high-pass
    prev = noise;
    samples[i] = hp * Math.exp(-t * 80) * 0.5;
  }
  return { sampleRate, samples };
}

/** A default drum bank keyed by conventional ids ("kick", "snare", "hat"). */
export function synthDrumBank(sampleRate = 44100): SampleBank {
  const bank: SampleBank = new Map();
  bank.set('kick', synthKick(sampleRate));
  bank.set('snare', synthSnare(sampleRate));
  bank.set('hat', synthHat(sampleRate));
  return bank;
}
