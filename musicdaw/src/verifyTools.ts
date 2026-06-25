/**
 * Smoke verifier for the agent tool catalog (agent plane).
 * Run with bun: `bun run src/verifyTools.ts`.
 *
 * Proves the agent can drive the DAW purely through tool calls — the same
 * surface the MCP server will expose — including a multi-step "make a beat"
 * sequence and a "listen then comp in the heard key" flow.
 */

import assert from 'node:assert/strict';

import { TOOL_DEFS, dispatchTool } from './agent/tools';
import { chordFromMidi } from './analysis/signal';
import { createProject } from './shared/factory';
import type { Project } from './shared/schema';

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

test('tool catalog is non-empty and well-formed', () => {
  assert.ok(TOOL_DEFS.length >= 10);
  for (const t of TOOL_DEFS) {
    assert.ok(t.name.length > 0);
    assert.ok(t.description.length > 0);
  }
});

test('unknown tool returns ok:false, does not throw', () => {
  const r = dispatchTool('nope', {}, { project: createProject('x') });
  assert.equal(r.ok, false);
});

test('bad params return ok:false, do not throw', () => {
  const r = dispatchTool('set_tempo', { bpm: 'fast' }, { project: createProject('x') });
  assert.equal(r.ok, false);
});

test('AGENT FLOW: build a 2-step kick beat via tools only', () => {
  let project: Project = createProject('AgentBeat');

  let r = dispatchTool('set_tempo', { bpm: 140 }, { project });
  assert.ok(r.ok);
  project = r.project as Project;
  assert.equal(project.tempo, 140);

  r = dispatchTool('add_track', { name: 'Drums' }, { project });
  assert.ok(r.ok);
  project = r.project as Project;
  const trackId = r.data?.trackId as string;
  assert.ok(trackId);

  r = dispatchTool('add_pattern_clip', { trackId, lengthBeat: 4 }, { project });
  assert.ok(r.ok);
  project = r.project as Project;
  const clipId = r.data?.clipId as string;

  r = dispatchTool('set_step', { trackId, clipId, step: 0, sampleId: 'kick', velocity: 120 }, { project });
  project = r.project as Project;
  r = dispatchTool('set_step', { trackId, clipId, step: 8, sampleId: 'kick', velocity: 110 }, { project });
  project = r.project as Project;

  const steps = project.tracks[0].clips[0].steps ?? [];
  assert.equal(steps.length, 2);
});

test('AGENT FLOW: listen returns key + suggested progression', () => {
  const audio = { samples: chordFromMidi([60, 64, 67], 1.0, SR), sampleRate: SR };
  const r = dispatchTool('listen', {}, { project: createProject('x'), audio });
  assert.ok(r.ok);
  assert.ok(typeof r.data?.key === 'string');
  assert.ok(Array.isArray(r.data?.suggestedProgression));
});

test('listen without audio returns ok:false', () => {
  const r = dispatchTool('listen', {}, { project: createProject('x') });
  assert.equal(r.ok, false);
});

test('AGENT FLOW: comp progression in heard key writes notes', () => {
  let project: Project = createProject('x');
  // add a midi track + clip via tools, then comp
  let r = dispatchTool('add_track', { name: 'Keys', type: 'midi' }, { project });
  project = r.project as Project;
  const trackId = r.data?.trackId as string;
  // give it a midi clip directly (no tool creates midi clips yet; emulate minimal)
  const clipId = 'c1';
  project = {
    ...project,
    tracks: project.tracks.map((t) =>
      t.id === trackId ? { ...t, clips: [{ id: clipId, startBeat: 0, lengthBeat: 16, kind: 'midi', notes: [] }] } : t
    ),
  };

  const audio = { samples: chordFromMidi([60, 64, 67], 1.0, SR), sampleRate: SR };
  r = dispatchTool('comp_progression_in_heard_key', { trackId, clipId, beatsPerChord: 4 }, { project, audio });
  assert.ok(r.ok, r.message);
  project = r.project as Project;
  const notes = project.tracks[0].clips[0].notes ?? [];
  assert.equal(notes.length, 12); // 4 chords x 3 notes
});

test('add_effect then set_effect_param via tools', () => {
  let project: Project = createProject('x');
  let r = dispatchTool('add_track', { name: 'A' }, { project });
  project = r.project as Project;
  const trackId = r.data?.trackId as string;
  r = dispatchTool('add_effect', { trackId, kind: 'reverb' }, { project });
  project = r.project as Project;
  const effectId = r.data?.effectId as string;
  r = dispatchTool('set_effect_param', { trackId, effectId, param: 'wet', value: 0.6 }, { project });
  project = r.project as Project;
  assert.equal(project.tracks[0].effects[0].params.wet, 0.6);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
