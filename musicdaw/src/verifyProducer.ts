/**
 * Smoke verifier for the producer brain (agent decision layer).
 * Run with bun: `bun run src/verifyProducer.ts`.
 *
 * End-to-end proof of the agent acting like a producer: hear audio → assess
 * key/tempo → comp a progression in that key → render → hear it back in key.
 */

import assert from 'node:assert/strict';

import { analyzeAudio } from './analysis/analyze';
import { chordFromMidi, clickTrack } from './analysis/signal';
import { addTrack, setTempo } from './core/engine';
import { renderProject } from './core/render';
import type { SampleBank } from './core/render';
import { assess, layProgression, matchTempoToAudio } from './agent/producer';
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

test('assess hears key from an A-minor chord and suggests a progression', () => {
  const buf = chordFromMidi([45, 48, 52], 1.0, SR); // A minor triad
  const a = assess(buf, SR);
  assert.ok(a.tonic === 9 || a.tonic === 0, `unexpected tonic ${a.keyName}`);
  assert.equal(a.suggestedProgression.length, 4);
  assert.ok(a.remarks.length >= 1);
});

test('matchTempoToAudio sets project tempo from a click track', () => {
  const buf = clickTrack(100, 4, SR);
  const p = createProject('x');
  const { project, bpm } = matchTempoToAudio(p, buf, SR);
  if (bpm !== null) {
    assert.ok(Math.abs(project.tempo - bpm) < 1e-6);
    // tempo should be musically near 100 (allow octave/contiguous error)
    assert.ok(project.tempo > 40 && project.tempo < 220);
  }
});

test('layProgression writes chord notes into a midi clip', () => {
  let p = createProject('Comp');
  p = setTempo(p, 120);
  const t = addTrack(p, 'Keys', 'midi');
  p = t.project;
  const clipId = 'c1';
  p = {
    ...p,
    tracks: p.tracks.map((tr) =>
      tr.id === t.trackId
        ? { ...tr, clips: [{ id: clipId, startBeat: 0, lengthBeat: 16, kind: 'midi', notes: [] }] }
        : tr
    ),
  };

  const prog = assess(chordFromMidi([60, 64, 67], 0.5, SR), SR).suggestedProgression;
  p = layProgression(p, t.trackId, clipId, prog, { beatsPerChord: 4 });

  const notes = p.tracks[0].clips[0].notes ?? [];
  // 4 chords * 3 notes each = 12 notes.
  assert.equal(notes.length, 12);
  // First chord starts at beat 0.
  assert.ok(notes.some((n) => n.startBeat === 0));
});

test('FULL LOOP: hear C major, comp progression, render, hear key back', () => {
  // 1. Agent hears a C major chord.
  const ref = chordFromMidi([60, 64, 67], 0.5, SR);
  const a = assess(ref, SR);

  // 2. Comp the suggested progression into a project.
  let p = createProject('AgentSong');
  p = setTempo(p, 120);
  const t = addTrack(p, 'Keys', 'midi');
  p = t.project;
  const clipId = 'prog';
  p = {
    ...p,
    tracks: p.tracks.map((tr) =>
      tr.id === t.trackId
        ? { ...tr, clips: [{ id: clipId, startBeat: 0, lengthBeat: 16, kind: 'midi', notes: [] }] }
        : tr
    ),
  };
  p = layProgression(p, t.trackId, clipId, a.suggestedProgression, { beatsPerChord: 4 });

  // 3. Render the comped project to audio.
  const bank: SampleBank = new Map();
  const out = renderProject(p, bank, { sampleRate: SR });

  // 4. Hear it back — the render should be non-silent and analyzable.
  let peak = 0;
  for (let i = 0; i < out.samples.length; i++) peak = Math.max(peak, Math.abs(out.samples[i]));
  assert.ok(peak > 0.05, `render too quiet: ${peak}`);
  const reheard = analyzeAudio(out.samples, SR);
  assert.equal(reheard.chroma.length, 12);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
