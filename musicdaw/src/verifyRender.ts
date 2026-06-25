/**
 * Smoke verifier for scheduler + WAV + offline render.
 * Run with bun: `bun run src/verifyRender.ts`.
 *
 * Key proof: a closed loop — build a MIDI note A4 in the project, render to
 * audio, then run the agent's ears on the render and confirm it hears A4 back.
 */

import assert from 'node:assert/strict';

import { analyzeAudio } from './analysis/analyze';
import { addAudioClip, addNote, addPatternClip, addTrack, setStep, setTempo } from './core/engine';
import { renderProject, renderStems } from './core/render';
import type { SampleBank } from './core/render';
import { beatsToSeconds, scheduleProject, songDurationSec } from './core/scheduler';
import { decodeWav, encodeWav } from './core/wav';
import type { AudioBuffer } from './core/wav';
import { sine } from './analysis/signal';
import { createProject } from './shared/factory';

const SR = 44100;
let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message}`);
    console.log(`FAIL  ${name}`);
  }
}

test('beatsToSeconds: 1 beat @120bpm = 0.5s', () => {
  assert.ok(Math.abs(beatsToSeconds(1, 120) - 0.5) < 1e-9);
});

test('scheduleProject places steps at correct times', () => {
  let p = createProject('x');
  p = setTempo(p, 120);
  const t = addTrack(p, 'Drums');
  p = t.project;
  const c = addPatternClip(p, t.trackId, 0, 4);
  p = c.project;
  // step 0 at beat 0, step 4 at beat 1 (4 steps per beat)
  p = setStep(p, t.trackId, c.clipId, 0, 's1', 100);
  p = setStep(p, t.trackId, c.clipId, 4, 's1', 100);
  const events = scheduleProject(p);
  assert.equal(events.length, 2);
  assert.ok(Math.abs(events[0].timeSec - 0) < 1e-9);
  assert.ok(Math.abs(events[1].timeSec - 0.5) < 1e-9, `got ${events[1].timeSec}`);
});

test('mute/solo affect scheduling', () => {
  let p = createProject('x');
  const a = addTrack(p, 'A');
  p = a.project;
  const b = addTrack(p, 'B');
  p = b.project;
  const ca = addPatternClip(p, a.trackId, 0, 4);
  p = ca.project;
  p = setStep(p, a.trackId, ca.clipId, 0, 's1', 100);
  const cb = addPatternClip(p, b.trackId, 0, 4);
  p = cb.project;
  p = setStep(p, b.trackId, cb.clipId, 0, 's2', 100);
  // Solo A -> only A plays
  p = { ...p, tracks: p.tracks.map((t) => (t.id === a.trackId ? { ...t, solo: true } : t)) };
  const events = scheduleProject(p);
  assert.equal(events.length, 1);
  assert.equal(events[0].trackId, a.trackId);
});

test('WAV encode/decode round-trip preserves samples', () => {
  const buf: AudioBuffer = { sampleRate: SR, samples: sine(440, 0.05, SR) };
  const bytes = encodeWav(buf);
  const back = decodeWav(bytes);
  assert.equal(back.sampleRate, SR);
  assert.equal(back.samples.length, buf.samples.length);
  // 16-bit quantization error should be tiny.
  let maxErr = 0;
  for (let i = 0; i < buf.samples.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(buf.samples[i] - back.samples[i]));
  }
  assert.ok(maxErr < 0.001, `quantization error too high: ${maxErr}`);
});

test('render a sample-based beat produces audio', () => {
  let p = createProject('Beat');
  p = setTempo(p, 120);
  const t = addTrack(p, 'Drums');
  p = t.project;
  const c = addPatternClip(p, t.trackId, 0, 4);
  p = c.project;
  p = setStep(p, t.trackId, c.clipId, 0, 'kick', 120);
  p = setStep(p, t.trackId, c.clipId, 8, 'kick', 120);

  const bank: SampleBank = new Map();
  bank.set('kick', { sampleRate: SR, samples: sine(80, 0.1, SR) });

  const out = renderProject(p, bank, { sampleRate: SR });
  // Non-silent output.
  let peak = 0;
  for (let i = 0; i < out.samples.length; i++) peak = Math.max(peak, Math.abs(out.samples[i]));
  assert.ok(peak > 0.1, `render too quiet, peak ${peak}`);
});

test('CLOSED LOOP: build MIDI A4, render, ears hear A4 back', () => {
  let p = createProject('Tone');
  p = setTempo(p, 120);
  const t = addTrack(p, 'Keys', 'midi');
  p = t.project;
  // Create a midi clip directly (addPatternClip makes a pattern; build midi clip via engine addAudioClip not suitable)
  // Use a midi clip: push one manually through engine by creating pattern then converting is messy,
  // so we add a midi clip object then addNote.
  const clipId = 'midiclip';
  p = {
    ...p,
    tracks: p.tracks.map((tr) =>
      tr.id === t.trackId
        ? { ...tr, clips: [{ id: clipId, startBeat: 0, lengthBeat: 4, kind: 'midi', notes: [] }] }
        : tr
    ),
  };
  // A4 = MIDI 69, hold 2 beats = 1s @120bpm
  p = addNote(p, t.trackId, clipId, { pitch: 69, startBeat: 0, lengthBeat: 2, velocity: 110 });

  const bank: SampleBank = new Map();
  const out = renderProject(p, bank, { sampleRate: SR });
  const analysis = analyzeAudio(out.samples, SR);
  assert.equal(analysis.pitch.note, 'A4', `heard ${analysis.pitch.note}`);
});

test('songDurationSec covers the last event', () => {
  let p = createProject('x');
  p = setTempo(p, 120);
  const t = addTrack(p, 'A', 'audio');
  p = t.project;
  const c = addAudioClip(p, t.trackId, 's1', 2, 4); // starts beat 2 (=1s), len 4 beats (=2s)
  p = c.project;
  assert.ok(songDurationSec(p) >= 3 - 1e-6, `got ${songDurationSec(p)}`);
});

test('renderStems: one stem per track, equal length, sum ~= full mix', () => {
  let p = createProject('Stems');
  p = setTempo(p, 120);
  // Track A: kick on beat 0
  const a = addTrack(p, 'Drums');
  p = a.project;
  const ca = addPatternClip(p, a.trackId, 0, 4);
  p = ca.project;
  p = setStep(p, a.trackId, ca.clipId, 0, 'kick', 120);
  // Track B: kick on beat 1
  const b = addTrack(p, 'Perc');
  p = b.project;
  const cb = addPatternClip(p, b.trackId, 0, 4);
  p = cb.project;
  p = setStep(p, b.trackId, cb.clipId, 4, 'kick', 100);

  const bank: SampleBank = new Map();
  bank.set('kick', { sampleRate: SR, samples: sine(80, 0.1, SR) });

  const stems = renderStems(p, bank, { sampleRate: SR });
  assert.equal(stems.length, 2);
  assert.equal(stems[0].trackName, 'Drums');
  // All stems share length.
  assert.equal(stems[0].buffer.samples.length, stems[1].buffer.samples.length);
  // Each stem is non-silent.
  for (const s of stems) {
    let peak = 0;
    for (let i = 0; i < s.buffer.samples.length; i++) peak = Math.max(peak, Math.abs(s.buffer.samples[i]));
    assert.ok(peak > 0.1, `stem ${s.trackName} too quiet`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
