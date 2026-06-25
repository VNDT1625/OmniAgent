/**
 * Runnable demo — produces a REAL .wav file you can open and listen to.
 *
 * This is the quickest way to actually "use" the engine today, without the
 * Electron app: the agent builds a short beat + a chord progression in a key,
 * renders it offline, and writes `out/demo.wav` to disk.
 *
 * Run:  bun run src/demo.ts
 * Then open musicdaw/out/demo.wav in any audio player.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { addPatternClip, addTrack, assignSampler, setStep, setTempo } from './core/engine';
import { renderProject } from './core/render';
import type { SampleBank } from './core/render';
import { layProgression } from './agent/producer';
import { suggestProgression } from './theory/theory';
import { createProject, createSample } from './shared/factory';
import { encodeWav } from './core/wav';
import { synthHat, synthKick } from './core/synth';
import type { Project } from './shared/schema';

const SR = 44100;

async function main(): Promise<void> {
  // --- Build a project the way the agent/user would, via engine commands ---
  let project: Project = createProject('Demo Song');
  project = setTempo(project, 90); // lofi-ish

  const kick = createSample('samples/kick.wav', 'Kick', 0.18);
  const hat = createSample('samples/hat.wav', 'Hat', 0.05);
  project = { ...project, samples: [kick, hat] };

  // Drums track with a simple boom-bap pattern (16 steps = 4 beats).
  const drums = addTrack(project, 'Drums');
  project = drums.project;
  project = assignSampler(project, drums.trackId, kick.id);
  const drumClip = addPatternClip(project, drums.trackId, 0, 4);
  project = drumClip.project;
  // Kick on 1 and the "and" of 2; hats on every off-beat.
  for (const s of [0, 6, 10]) project = setStep(project, drums.trackId, drumClip.clipId, s, kick.id, 120);
  for (const s of [2, 4, 6, 8, 10, 12, 14]) project = setStep(project, drums.trackId, drumClip.clipId, s, hat.id, 70);

  // Keys track: comp a chord progression in A minor (lofi favourite).
  const keys = addTrack(project, 'Keys', 'midi');
  project = keys.project;
  const keysClipId = 'keys-clip';
  project = {
    ...project,
    tracks: project.tracks.map((t) =>
      t.id === keys.trackId
        ? { ...t, volumeDb: -6, clips: [{ id: keysClipId, startBeat: 0, lengthBeat: 16, kind: 'midi', notes: [] }] }
        : t
    ),
  };
  const progression = suggestProgression(9, 'minor'); // A minor: Am - F - C - G
  project = layProgression(project, keys.trackId, keysClipId, progression, {
    octave: 4,
    beatsPerChord: 4,
    velocity: 70,
  });

  // --- Render offline to a single mono buffer, write WAV to disk ---
  const bank: SampleBank = new Map();
  bank.set(kick.id, synthKick(SR));
  bank.set(hat.id, synthHat(SR));

  const rendered = renderProject(project, bank, { sampleRate: SR, tailSec: 1 });
  const wav = encodeWav(rendered);

  const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'demo.wav');
  await fs.writeFile(outPath, wav);

  console.log('Project:', project.name, `| tempo ${project.tempo} BPM | key A minor`);
  console.log('Progression:', progression.map((c) => c.name).join(' - '));
  console.log('Tracks:', project.tracks.map((t) => t.name).join(', '));
  console.log(`Rendered ${(rendered.samples.length / SR).toFixed(2)}s of audio.`);
  console.log(`\nWrote: ${outPath}`);
  console.log('Open it in any audio player to listen.');
}

void main();
