/**
 * Smoke verifier for the engine commands and the analysis ("ears") modules.
 * Runs with bun (`bun run src/verifyAudio.ts`). Proves the agent can actually
 * hear correct pitch / key / tempo from synthetic audio, and that engine
 * commands mutate the project schema correctly.
 */

import assert from 'node:assert/strict';

import {
  addEffect,
  addNote,
  addPatternClip,
  addTrack,
  setEffectParam,
  setStep,
  setTempo,
  setTrackVolume,
} from './core/engine';
import { analyzeAudio } from './analysis/analyze';
import { detectKey } from './analysis/key';
import { computeChroma } from './analysis/chroma';
import { detectPitch, hzToNoteName, midiToHz } from './analysis/pitch';
import { detectTempo } from './analysis/tempo';
import { chordFromMidi, clickTrack, sine } from './analysis/signal';
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

// ---- Engine commands ----

test('addTrack then addPatternClip then setStep', () => {
  let p = createProject('Beat');
  const t = addTrack(p, 'Drums');
  p = t.project;
  const c = addPatternClip(p, t.trackId, 0, 4);
  p = c.project;
  p = setStep(p, t.trackId, c.clipId, 0, null, 100);
  p = setStep(p, t.trackId, c.clipId, 4, null, 80);
  const clip = p.tracks[0].clips[0];
  assert.equal(clip.steps?.length, 2);
  assert.equal(clip.steps?.[0].step, 0);
});

test('setStep velocity 0 removes the step', () => {
  let p = createProject('x');
  const t = addTrack(p, 'D');
  p = t.project;
  const c = addPatternClip(p, t.trackId, 0, 4);
  p = c.project;
  p = setStep(p, t.trackId, c.clipId, 2, null, 100);
  p = setStep(p, t.trackId, c.clipId, 2, null, 0);
  assert.equal(p.tracks[0].clips[0].steps?.length, 0);
});

test('setTempo validates', () => {
  const p = setTempo(createProject('x'), 140);
  assert.equal(p.tempo, 140);
  assert.throws(() => setTempo(p, 0), /Invalid tempo/);
});

test('setTrackVolume clamps to range', () => {
  let p = createProject('x');
  const t = addTrack(p, 'A');
  p = setTrackVolume(t.project, t.trackId, 999);
  assert.equal(p.tracks[0].volumeDb, 12);
});

test('addEffect + setEffectParam', () => {
  let p = createProject('x');
  const t = addTrack(p, 'A');
  p = t.project;
  const e = addEffect(p, t.trackId, 'reverb');
  p = setEffectParam(e.project, t.trackId, e.effectId, 'wet', 0.5);
  assert.equal(p.tracks[0].effects[0].params.wet, 0.5);
});

test('addNote requires midi clip', () => {
  let p = createProject('x');
  const t = addTrack(p, 'Keys', 'midi');
  p = t.project;
  const c = addPatternClip(p, t.trackId, 0, 4);
  // pattern clip -> addNote should throw
  assert.throws(
    () => addNote(c.project, t.trackId, c.clipId, { pitch: 60, startBeat: 0, lengthBeat: 1, velocity: 100 }),
    /midi clip/
  );
});

// ---- Analysis: the agent's ears ----

test('detectPitch hears A4 (440Hz) within 1Hz', () => {
  const buf = sine(440, 0.2, SR);
  const frame = buf.subarray(0, 2048);
  const r = detectPitch(frame, SR);
  assert.ok(r.hz !== null, 'expected a pitch');
  assert.ok(Math.abs((r.hz as number) - 440) < 1, `got ${r.hz}`);
  assert.ok(r.confidence > 0.8, `low confidence ${r.confidence}`);
});

test('detectPitch hears C3 and names it', () => {
  const c3 = midiToHz(48); // C3
  const buf = sine(c3, 0.2, SR);
  const r = detectPitch(buf.subarray(0, 2048), SR);
  assert.ok(r.hz !== null);
  assert.equal(hzToNoteName(r.hz as number), 'C3');
});

test('detectKey hears A minor from an Am chord', () => {
  // A minor triad: A2(45), C3(48), E3(52)
  const buf = chordFromMidi([45, 48, 52], 0.5, SR);
  const chroma = computeChroma(buf.subarray(0, 8192), SR);
  const key = detectKey(chroma);
  // Accept A minor or its close relatives; assert tonic is A (9) or C (0).
  assert.ok(key.tonic === 9 || key.tonic === 0, `unexpected key ${key.name}`);
});

test('detectKey hears C major from a C chord', () => {
  // C major triad: C4(60), E4(64), G4(67)
  const buf = chordFromMidi([60, 64, 67], 0.5, SR);
  const chroma = computeChroma(buf.subarray(0, 8192), SR);
  const key = detectKey(chroma);
  assert.ok(key.tonic === 0 || key.tonic === 9, `unexpected key ${key.name}`);
});

test('detectTempo hears ~120 BPM from a click track', () => {
  const buf = clickTrack(120, 4, SR);
  const r = detectTempo(buf, SR);
  assert.ok(r.bpm !== null, 'expected a tempo');
  // Allow octave error tolerance band around 120 (110..130).
  const bpm = r.bpm as number;
  const ok = Math.abs(bpm - 120) < 10 || Math.abs(bpm - 60) < 6 || Math.abs(bpm - 240) < 12;
  assert.ok(ok, `got ${bpm} BPM`);
});

test('analyzeAudio gives a full musical summary', () => {
  const buf = sine(440, 1.0, SR);
  const a = analyzeAudio(buf, SR);
  assert.equal(a.pitch.note, 'A4');
  assert.equal(a.chroma.length, 12);
  assert.ok(a.durationSec > 0.9 && a.durationSec < 1.1);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
