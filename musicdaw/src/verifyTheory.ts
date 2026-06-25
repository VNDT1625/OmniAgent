/**
 * Smoke verifier for the theory + vocal-tune planning layer.
 * Run with bun: `bun run src/verifyTheory.ts`.
 *
 * Proves the "producer brain": in-key detection, diatonic chords, snapping
 * notes to key, and key-aware tune corrections behave musically.
 */

import assert from 'node:assert/strict';

import { hzToMidi, midiToHz } from './analysis/pitch';
import {
  buildChord,
  diatonicChords,
  isInKey,
  scalePitchClasses,
  snapMidiToKey,
  suggestProgression,
} from './theory/theory';
import { correctFrequency, meanAbsCentsShift, planTune } from './theory/tune';
import type { PitchFrame } from './theory/tune';

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

const C = 0;
const A = 9;

test('C major scale pitch classes', () => {
  assert.deepEqual(scalePitchClasses(C, 'major'), [0, 2, 4, 5, 7, 9, 11]);
});

test('A natural minor scale pitch classes', () => {
  // A B C D E F G
  assert.deepEqual(scalePitchClasses(A, 'minor'), [9, 11, 0, 2, 4, 5, 7]);
});

test('isInKey: F# not in C major, F is', () => {
  assert.equal(isInKey(6, C, 'major'), false); // F#
  assert.equal(isInKey(5, C, 'major'), true); // F
});

test('diatonic chords of C major start on C and are I=maj ii=min', () => {
  const chords = diatonicChords(C, 'major');
  assert.equal(chords[0].name, 'C');
  assert.equal(chords[0].quality, 'maj');
  assert.equal(chords[1].quality, 'min'); // Dm
  assert.equal(chords[6].quality, 'dim'); // Bdim
});

test('buildChord names', () => {
  assert.equal(buildChord(A, 'min').name, 'Am');
  assert.equal(buildChord(7, 'maj').name, 'G');
});

test('suggestProgression C major = C G Am F', () => {
  const names = suggestProgression(C, 'major').map((c) => c.name);
  assert.deepEqual(names, ['C', 'G', 'Am', 'F']);
});

test('snapMidiToKey moves F#4 to a C-major note', () => {
  const fSharp4 = 66; // F#4, not in C major
  const snapped = snapMidiToKey(fSharp4, C, 'major');
  const pc = ((snapped % 12) + 12) % 12;
  assert.ok(pc === 5 || pc === 7, `snapped to pc ${pc}`); // F or G
  assert.ok(Math.abs(snapped - fSharp4) <= 1);
});

test('snapMidiToKey leaves an in-key note unchanged', () => {
  const c4 = 60;
  assert.equal(snapMidiToKey(c4, C, 'major'), 60);
});

test('correctFrequency at 100% snaps a sharp note down to target', () => {
  // Sing slightly sharp of A4 (440). 450Hz -> should pull toward 440 (A is in A minor).
  const { toHz, centsShift } = correctFrequency(450, A, 'minor', 100);
  assert.ok(Math.abs(toHz - 440) < 1, `got ${toHz}`);
  assert.ok(centsShift < 0, 'should shift down');
});

test('correctFrequency at 0% leaves pitch unchanged', () => {
  const { toHz } = correctFrequency(450, A, 'minor', 0);
  assert.ok(Math.abs(toHz - 450) < 1e-6);
});

test('correctFrequency at 50% moves halfway (in cents)', () => {
  const hz = 450;
  const full = correctFrequency(hz, A, 'minor', 100).centsShift;
  const half = correctFrequency(hz, A, 'minor', 50).centsShift;
  assert.ok(Math.abs(half - full / 2) < 1e-6, `half=${half} full=${full}`);
});

test('planTune skips low-confidence/unvoiced frames', () => {
  const frames: PitchFrame[] = [
    { timeSec: 0, hz: 450, confidence: 0.9 },
    { timeSec: 0.1, hz: null, confidence: 0 },
    { timeSec: 0.2, hz: 460, confidence: 0.2 },
    { timeSec: 0.3, hz: 220, confidence: 0.8 },
  ];
  const corrections = planTune(frames, { tonic: A, scale: 'minor', strengthPct: 100 });
  assert.equal(corrections.length, 2); // only the two confident voiced frames
});

test('meanAbsCentsShift reflects off-key amount', () => {
  const inTune = planTune([{ timeSec: 0, hz: midiToHz(hzToMidi(440)), confidence: 1 }], {
    tonic: A,
    scale: 'minor',
    strengthPct: 100,
  });
  assert.ok(meanAbsCentsShift(inTune) < 5, 'in-tune take should need little correction');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
