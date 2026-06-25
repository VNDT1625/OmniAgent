/**
 * Offline renderer — mixes scheduled events into a single mono PCM buffer.
 *
 * Headless and pure: takes a Project + a sample bank (decoded PCM per sampleId)
 * and produces an AudioBuffer that `encodeWav` can write to disk. The renderer
 * is the same regardless of whether export runs in the renderer
 * (OfflineAudioContext alternative) or the main process / Rust sidecar later.
 *
 * For 'note' events without a sampler, a simple sine tone is synthesized so the
 * agent and tests can hear MIDI parts even before instruments are wired.
 */

import { midiToHz } from '../analysis/pitch';
import { scheduleProject, songDurationSec } from './scheduler';
import type { ScheduledEvent } from './scheduler';
import type { AudioBuffer } from './wav';
import type { Project } from '../shared/schema';

/** Decoded sample data keyed by Sample.id. */
export type SampleBank = Map<string, AudioBuffer>;

export type RenderOptions = {
  sampleRate?: number;
  /** Extra seconds of tail to avoid cutting reverbs/releases. */
  tailSec?: number;
};

/** One rendered stem (a single track bounced on its own). */
export type Stem = {
  trackId: string;
  trackName: string;
  buffer: AudioBuffer;
};

const DEFAULT_SR = 44100;

/** Mix a list of scheduled events into a pre-sized buffer (in place). */
function mixEvents(events: ScheduledEvent[], bank: SampleBank, sampleRate: number, mix: Float32Array): void {
  const total = mix.length;
  for (const ev of events) {
    const startFrame = Math.floor(ev.timeSec * sampleRate);

    if (ev.kind === 'sample' && ev.sampleId) {
      const src = bank.get(ev.sampleId);
      if (!src) continue;
      const resampled =
        src.sampleRate === sampleRate ? src.samples : resampleLinear(src.samples, src.sampleRate, sampleRate);
      const len =
        ev.durationSec > 0 ? Math.min(resampled.length, Math.floor(ev.durationSec * sampleRate)) : resampled.length;
      for (let i = 0; i < len; i++) {
        const dst = startFrame + i;
        if (dst >= 0 && dst < total) mix[dst] += resampled[i] * ev.gain;
      }
    } else if (ev.kind === 'note' && ev.pitch !== undefined) {
      // Synthesize a sine with a short linear AR envelope.
      const hz = midiToHz(ev.pitch);
      const len = Math.max(1, Math.floor(ev.durationSec * sampleRate));
      const attack = Math.min(len, Math.floor(sampleRate * 0.005));
      const release = Math.min(len, Math.floor(sampleRate * 0.02));
      const w = (2 * Math.PI * hz) / sampleRate;
      for (let i = 0; i < len; i++) {
        const dst = startFrame + i;
        if (dst < 0 || dst >= total) continue;
        let env = 1;
        if (i < attack) env = i / attack;
        else if (i > len - release) env = Math.max(0, (len - i) / release);
        mix[dst] += Math.sin(w * i) * ev.gain * env;
      }
    }
  }
}

/** Apply master gain + soft safety clip to a buffer in place. */
function applyMaster(mix: Float32Array, masterDb: number): void {
  const masterGain = Math.pow(10, masterDb / 20);
  for (let i = 0; i < mix.length; i++) mix[i] = softClip(mix[i] * masterGain);
}

export function renderProject(project: Project, bank: SampleBank, options: RenderOptions = {}): AudioBuffer {
  const sampleRate = options.sampleRate ?? DEFAULT_SR;
  const tailSec = options.tailSec ?? 0.5;
  const events = scheduleProject(project);
  const durationSec = songDurationSec(project) + tailSec;
  const total = Math.max(1, Math.ceil(durationSec * sampleRate));
  const mix = new Float32Array(total);

  mixEvents(events, bank, sampleRate, mix);
  applyMaster(mix, project.master.volumeDb);
  return { sampleRate, samples: mix };
}

/**
 * Render each track to its own buffer (stems). Mute/solo are ignored so every
 * track yields a full stem; track volume/pan still apply via the scheduler.
 * All stems share the same length (the full song duration) so they line up.
 */
export function renderStems(project: Project, bank: SampleBank, options: RenderOptions = {}): Stem[] {
  const sampleRate = options.sampleRate ?? DEFAULT_SR;
  const tailSec = options.tailSec ?? 0.5;
  const total = Math.max(1, Math.ceil((songDurationSec(project) + tailSec) * sampleRate));

  // Schedule the whole project once, then bucket events by track.
  const allEvents = scheduleProject({
    ...project,
    tracks: project.tracks.map((t) => ({ ...t, mute: false, solo: false })),
  });
  const byTrack = new Map<string, ScheduledEvent[]>();
  for (const ev of allEvents) {
    const list = byTrack.get(ev.trackId) ?? [];
    list.push(ev);
    byTrack.set(ev.trackId, list);
  }

  const stems: Stem[] = [];
  for (const track of project.tracks) {
    const events = byTrack.get(track.id) ?? [];
    const mix = new Float32Array(total);
    mixEvents(events, bank, sampleRate, mix);
    applyMaster(mix, project.master.volumeDb);
    stems.push({ trackId: track.id, trackName: track.name, buffer: { sampleRate, samples: mix } });
  }
  return stems;
}

/** Linear resampling (good enough for export MVP; Rust path can do better). */
function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const ratio = toRate / fromRate;
  const outLen = Math.floor(samples.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = srcPos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

/** Gentle tanh-style soft clip. */
function softClip(x: number): number {
  if (x > 1) return 1;
  if (x < -1) return -1;
  return x - (x * x * x) / 3;
}
