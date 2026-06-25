/**
 * Synthetic signal generators for testing the analysis ("ears") modules.
 * Deterministic, dependency-free. Used by the verifier to prove the agent
 * actually hears correct pitch/key/tempo from generated audio.
 */

import { midiToHz } from './pitch';

/** A pure sine tone. */
export function sine(hz: number, durationSec: number, sampleRate: number, amplitude = 0.8): Float32Array {
  const n = Math.floor(durationSec * sampleRate);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * hz) / sampleRate;
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin(w * i);
  return out;
}

/** Sum of sines (e.g. to build a chord from MIDI notes). */
export function chordFromMidi(midiNotes: number[], durationSec: number, sampleRate: number): Float32Array {
  const n = Math.floor(durationSec * sampleRate);
  const out = new Float32Array(n);
  for (const midi of midiNotes) {
    const hz = midiToHz(midi);
    const w = (2 * Math.PI * hz) / sampleRate;
    for (let i = 0; i < n; i++) out[i] += Math.sin(w * i);
  }
  const scale = midiNotes.length > 0 ? 0.8 / midiNotes.length : 1;
  for (let i = 0; i < n; i++) out[i] *= scale;
  return out;
}

/**
 * A click track: short energy bursts at a fixed BPM. Used to verify tempo
 * detection. Each click is a brief decaying noise/impulse.
 */
export function clickTrack(bpm: number, durationSec: number, sampleRate: number): Float32Array {
  const n = Math.floor(durationSec * sampleRate);
  const out = new Float32Array(n);
  const samplesPerBeat = Math.floor((60 / bpm) * sampleRate);
  const clickLen = Math.floor(sampleRate * 0.02); // 20ms click
  for (let beat = 0; beat * samplesPerBeat < n; beat++) {
    const start = beat * samplesPerBeat;
    for (let i = 0; i < clickLen && start + i < n; i++) {
      const decay = 1 - i / clickLen;
      // Impulse-ish: high-amplitude decaying sine burst.
      out[start + i] = Math.sin((2 * Math.PI * 2000 * i) / sampleRate) * decay;
    }
  }
  return out;
}
