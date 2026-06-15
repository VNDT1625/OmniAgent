/**
 * MusicDAW CLI — make music from the terminal today, no Electron app needed.
 *
 * This is a usable entry point for BOTH a human and an agent: feed it a JSON
 * file describing a sequence of tool calls (the same agent-plane tools), it
 * applies them to a project, renders audio, and writes a WAV. It proves the
 * whole headless stack works end to end as a real, runnable program.
 *
 * Usage:
 *   bun run src/cli.ts <script.json> [outfile.wav]
 *   bun run src/cli.ts --demo                # built-in demo script
 *
 * Script JSON shape:
 *   {
 *     "name": "My Song",
 *     "calls": [
 *       { "tool": "set_tempo", "args": { "bpm": 120 } },
 *       { "tool": "add_track", "args": { "name": "Drums" }, "saveAs": "drumTrack" },
 *       { "tool": "add_pattern_clip", "args": { "trackId": "$drumTrack.trackId" }, "saveAs": "clip" },
 *       { "tool": "set_step", "args": { "trackId": "$drumTrack.trackId", "clipId": "$clip.clipId", "step": 0, "velocity": 120 } }
 *     ]
 *   }
 *
 * Placeholders: any arg string "$name.field" is replaced with the `data.field`
 * returned by an earlier call that used "saveAs": "name". This lets a script
 * reference ids created by previous steps — exactly how an agent would chain.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dispatchTool } from './agent/tools';
import { renderProject, renderStems } from './core/render';
import type { SampleBank } from './core/render';
import { encodeWav } from './core/wav';
import { createProject } from './shared/factory';
import type { Project } from './shared/schema';
import { synthDrumBank } from './core/synth';

type ToolCall = { tool: string; args?: Record<string, unknown>; saveAs?: string };
type Script = { name?: string; calls: ToolCall[] };

/** Directory of this source file, ESM-standard (works in bun and node). */
function scriptDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

const DEMO_SCRIPT: Script = {
  name: 'CLI Demo',
  calls: [
    { tool: 'set_tempo', args: { bpm: 90 } },
    { tool: 'add_track', args: { name: 'Drums' }, saveAs: 'drums' },
    { tool: 'add_pattern_clip', args: { trackId: '$drums.trackId', lengthBeat: 4 }, saveAs: 'clip' },
    {
      tool: 'set_step',
      args: { trackId: '$drums.trackId', clipId: '$clip.clipId', step: 0, sampleId: 'kick', velocity: 120 },
    },
    {
      tool: 'set_step',
      args: { trackId: '$drums.trackId', clipId: '$clip.clipId', step: 6, sampleId: 'kick', velocity: 110 },
    },
    {
      tool: 'set_step',
      args: { trackId: '$drums.trackId', clipId: '$clip.clipId', step: 4, sampleId: 'hat', velocity: 70 },
    },
    {
      tool: 'set_step',
      args: { trackId: '$drums.trackId', clipId: '$clip.clipId', step: 12, sampleId: 'hat', velocity: 70 },
    },
  ],
};

/** Resolve "$name.field" placeholders against saved tool outputs. */
function resolveArgs(
  args: Record<string, unknown>,
  saved: Map<string, Record<string, unknown>>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.startsWith('$')) {
      const [ref, field] = v.slice(1).split('.');
      const bag = saved.get(ref);
      if (!bag || !(field in bag)) throw new Error(`Unresolved placeholder "${v}"`);
      out[k] = bag[field];
    } else {
      out[k] = v;
    }
  }
  return out;
}

function runScript(script: Script): Project {
  let project = createProject(script.name ?? 'Untitled');
  const saved = new Map<string, Record<string, unknown>>();

  script.calls.forEach((call, index) => {
    const args = resolveArgs(call.args ?? {}, saved);
    const result = dispatchTool(call.tool, args, { project });
    if (!result.ok) {
      throw new Error(`Call #${index + 1} "${call.tool}" failed: ${result.message}`);
    }
    if (result.project) project = result.project;
    if (call.saveAs && result.data) saved.set(call.saveAs, result.data);
    console.log(`  [${index + 1}/${script.calls.length}] ${call.tool}: ${result.message}`);
  });

  return project;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const isDemo = argv.includes('--demo') || argv.length === 0;

  let script: Script;
  let outFile: string;

  if (isDemo) {
    script = DEMO_SCRIPT;
    outFile = path.join(scriptDir(), '..', 'out', 'cli-demo.wav');
  } else {
    const scriptPath = argv[0];
    const raw = await fs.readFile(scriptPath, 'utf8');
    script = JSON.parse(raw) as Script;
    outFile = argv[1] ?? path.join(scriptDir(), '..', 'out', 'cli-out.wav');
  }

  console.log(`Running script "${script.name ?? 'Untitled'}" (${script.calls.length} calls):`);
  const project = runScript(script);

  // Default drum bank so sample-based steps make sound out of the box.
  const bank: SampleBank = synthDrumBank(44100);

  if (argv.includes('--stems')) {
    const stems = renderStems(project, bank, { sampleRate: 44100, tailSec: 1 });
    const stemsDir = path.join(path.dirname(outFile), 'stems');
    await fs.mkdir(stemsDir, { recursive: true });
    for (const stem of stems) {
      const safe = stem.trackName.replace(/[^a-z0-9_-]+/gi, '_');
      const stemPath = path.join(stemsDir, `${safe}.wav`);
      await fs.writeFile(stemPath, encodeWav(stem.buffer));
      console.log(`  stem → ${stemPath}`);
    }
  }

  const rendered = renderProject(project, bank, { sampleRate: 44100, tailSec: 1 });

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, encodeWav(rendered));

  console.log(`\nProject "${project.name}" | tempo ${project.tempo} BPM | ${project.tracks.length} track(s)`);
  console.log(`Rendered ${(rendered.samples.length / 44100).toFixed(2)}s → ${outFile}`);
}

void main();
