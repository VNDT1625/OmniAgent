/**
 * Music tool catalog — the agent plane.
 *
 * Defines the tools the agent can call to make music, decoupled from any MCP
 * transport. Each tool has a name, JSON-schema-ish input description, and a
 * pure handler that operates on a project (+ optional analysis input) and
 * returns a result plus the (possibly) updated project.
 *
 * The real MCP server (`aionui-music`, wired in the host app) is a thin adapter
 * that maps tool calls to `dispatchTool`. Keeping this layer pure means it is
 * fully testable with bun and reusable by UI "assist" actions too.
 */

import {
  addEffect,
  addPatternClip,
  addTrack,
  assignSampler,
  setEffectParam,
  setStep,
  setTempo,
  setTrackPan,
  setTrackVolume,
} from '../core/engine';
import { assess, layProgression, matchTempoToAudio } from './producer';
import type { EffectKind, Project, TrackType } from '../shared/schema';

export type ToolParam = {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  description: string;
};

export type ToolDef = {
  name: string;
  description: string;
  params: ToolParam[];
};

/** Result envelope every tool returns. */
export type ToolResult = {
  ok: boolean;
  /** Updated project, present when the tool mutated it. */
  project?: Project;
  /** Human/agent-readable summary of what happened. */
  message: string;
  /** Optional structured data (e.g. analysis, created ids). */
  data?: Record<string, unknown>;
};

/** Audio provided to "listen" tools (decoded mono PCM). */
export type ToolAudio = { samples: Float32Array; sampleRate: number };

export type ToolContext = {
  project: Project;
  /** Reference audio for listen/assess/tempo-match tools, if any. */
  audio?: ToolAudio;
};

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'set_tempo',
    description: 'Set the project tempo in BPM.',
    params: [{ name: 'bpm', type: 'number', required: true, description: 'Beats per minute (> 0).' }],
  },
  {
    name: 'add_track',
    description: 'Add a new track. type is instrument | audio | midi.',
    params: [
      { name: 'name', type: 'string', required: true, description: 'Track name.' },
      { name: 'type', type: 'string', required: false, description: 'instrument | audio | midi (default instrument).' },
    ],
  },
  {
    name: 'set_track_volume',
    description: 'Set a track volume in dB (-60..12).',
    params: [
      { name: 'trackId', type: 'string', required: true, description: 'Target track id.' },
      { name: 'db', type: 'number', required: true, description: 'Volume in dB.' },
    ],
  },
  {
    name: 'set_track_pan',
    description: 'Set a track pan (-1 left .. 1 right).',
    params: [
      { name: 'trackId', type: 'string', required: true, description: 'Target track id.' },
      { name: 'pan', type: 'number', required: true, description: 'Pan -1..1.' },
    ],
  },
  {
    name: 'assign_sampler',
    description: 'Assign a sample to a track sampler instrument.',
    params: [
      { name: 'trackId', type: 'string', required: true, description: 'Target track id.' },
      { name: 'sampleId', type: 'string', required: true, description: 'Sample id to assign.' },
    ],
  },
  {
    name: 'add_pattern_clip',
    description: 'Add an empty step-sequencer pattern clip to a track.',
    params: [
      { name: 'trackId', type: 'string', required: true, description: 'Target track id.' },
      { name: 'startBeat', type: 'number', required: false, description: 'Start position in beats (default 0).' },
      { name: 'lengthBeat', type: 'number', required: false, description: 'Length in beats (default 4).' },
    ],
  },
  {
    name: 'set_step',
    description: 'Set or clear a step in a pattern clip (velocity 0 clears).',
    params: [
      { name: 'trackId', type: 'string', required: true, description: 'Target track id.' },
      { name: 'clipId', type: 'string', required: true, description: 'Target clip id.' },
      { name: 'step', type: 'number', required: true, description: 'Step index (4 steps per beat).' },
      { name: 'sampleId', type: 'string', required: false, description: 'Sample id (defaults to track sampler).' },
      { name: 'velocity', type: 'number', required: true, description: '0..127 (0 clears the step).' },
    ],
  },
  {
    name: 'add_effect',
    description: 'Add an insert effect to a track: eq3 | compressor | reverb | delay.',
    params: [
      { name: 'trackId', type: 'string', required: true, description: 'Target track id.' },
      { name: 'kind', type: 'string', required: true, description: 'eq3 | compressor | reverb | delay.' },
    ],
  },
  {
    name: 'set_effect_param',
    description: 'Set a parameter on a track effect.',
    params: [
      { name: 'trackId', type: 'string', required: true, description: 'Target track id.' },
      { name: 'effectId', type: 'string', required: true, description: 'Target effect id.' },
      { name: 'param', type: 'string', required: true, description: 'Parameter name.' },
      { name: 'value', type: 'number', required: true, description: 'Parameter value.' },
    ],
  },
  {
    name: 'listen',
    description: 'Analyze the provided reference audio: returns key, tempo, dominant pitch, chroma.',
    params: [],
  },
  {
    name: 'match_tempo_to_audio',
    description: 'Detect tempo from reference audio and set the project tempo to it.',
    params: [],
  },
  {
    name: 'comp_progression_in_heard_key',
    description:
      'Listen to reference audio, then write a diatonic chord progression into a midi clip in the heard key.',
    params: [
      { name: 'trackId', type: 'string', required: true, description: 'Target midi track id.' },
      { name: 'clipId', type: 'string', required: true, description: 'Target midi clip id.' },
      { name: 'beatsPerChord', type: 'number', required: false, description: 'Beats per chord (default 4).' },
    ],
  },
];

function requireAudio(ctx: ToolContext): ToolAudio {
  if (!ctx.audio) throw new Error('This tool requires reference audio in the context.');
  return ctx.audio;
}

function num(args: Record<string, unknown>, key: string, fallback?: number): number {
  const v = args[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Param "${key}" must be a number`);
  return v;
}

function str(args: Record<string, unknown>, key: string, fallback?: string): string {
  const v = args[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'string') throw new Error(`Param "${key}" must be a string`);
  return v;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`Param "${key}" must be a string`);
  return v;
}

/**
 * Execute a tool by name. Pure: returns a result envelope; never throws for
 * normal "bad input" cases (returns ok:false instead) so the agent can recover.
 */
export function dispatchTool(name: string, args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  try {
    switch (name) {
      case 'set_tempo': {
        const bpm = num(args, 'bpm');
        return { ok: true, project: setTempo(ctx.project, bpm), message: `Tempo set to ${bpm} BPM.` };
      }
      case 'add_track': {
        const trackName = str(args, 'name');
        const type = (optStr(args, 'type') ?? 'instrument') as TrackType;
        const r = addTrack(ctx.project, trackName, type);
        return {
          ok: true,
          project: r.project,
          message: `Added ${type} track "${trackName}".`,
          data: { trackId: r.trackId },
        };
      }
      case 'set_track_volume': {
        const trackId = str(args, 'trackId');
        const db = num(args, 'db');
        return {
          ok: true,
          project: setTrackVolume(ctx.project, trackId, db),
          message: `Track volume set to ${db} dB.`,
        };
      }
      case 'set_track_pan': {
        const trackId = str(args, 'trackId');
        const pan = num(args, 'pan');
        return { ok: true, project: setTrackPan(ctx.project, trackId, pan), message: `Track pan set to ${pan}.` };
      }
      case 'assign_sampler': {
        const trackId = str(args, 'trackId');
        const sampleId = str(args, 'sampleId');
        return {
          ok: true,
          project: assignSampler(ctx.project, trackId, sampleId),
          message: `Assigned sample to track.`,
        };
      }
      case 'add_pattern_clip': {
        const trackId = str(args, 'trackId');
        const startBeat = num(args, 'startBeat', 0);
        const lengthBeat = num(args, 'lengthBeat', 4);
        const r = addPatternClip(ctx.project, trackId, startBeat, lengthBeat);
        return { ok: true, project: r.project, message: 'Added pattern clip.', data: { clipId: r.clipId } };
      }
      case 'set_step': {
        const trackId = str(args, 'trackId');
        const clipId = str(args, 'clipId');
        const step = num(args, 'step');
        const sampleId = optStr(args, 'sampleId') ?? null;
        const velocity = num(args, 'velocity');
        return {
          ok: true,
          project: setStep(ctx.project, trackId, clipId, step, sampleId, velocity),
          message: `Step ${step} ${velocity > 0 ? 'set' : 'cleared'}.`,
        };
      }
      case 'add_effect': {
        const trackId = str(args, 'trackId');
        const kind = str(args, 'kind') as EffectKind;
        const r = addEffect(ctx.project, trackId, kind);
        return { ok: true, project: r.project, message: `Added ${kind} effect.`, data: { effectId: r.effectId } };
      }
      case 'set_effect_param': {
        const trackId = str(args, 'trackId');
        const effectId = str(args, 'effectId');
        const param = str(args, 'param');
        const value = num(args, 'value');
        return {
          ok: true,
          project: setEffectParam(ctx.project, trackId, effectId, param, value),
          message: `Set ${param}=${value}.`,
        };
      }
      case 'listen': {
        const audio = requireAudio(ctx);
        const a = assess(audio.samples, audio.sampleRate);
        return {
          ok: true,
          message: a.remarks.join(' '),
          data: {
            key: a.keyName,
            tempoBpm: a.tempoBpm,
            dominantNote: a.analysis.pitch.note,
            suggestedProgression: a.suggestedProgression.map((c) => c.name),
          },
        };
      }
      case 'match_tempo_to_audio': {
        const audio = requireAudio(ctx);
        const r = matchTempoToAudio(ctx.project, audio.samples, audio.sampleRate);
        if (r.bpm === null) return { ok: false, message: 'No confident tempo detected; project tempo unchanged.' };
        return { ok: true, project: r.project, message: `Matched project tempo to ${r.bpm} BPM.` };
      }
      case 'comp_progression_in_heard_key': {
        const audio = requireAudio(ctx);
        const trackId = str(args, 'trackId');
        const clipId = str(args, 'clipId');
        const beatsPerChord = num(args, 'beatsPerChord', 4);
        const a = assess(audio.samples, audio.sampleRate);
        const project = layProgression(ctx.project, trackId, clipId, a.suggestedProgression, { beatsPerChord });
        return {
          ok: true,
          project,
          message: `Comped ${a.suggestedProgression.map((c) => c.name).join(' - ')} in ${a.keyName}.`,
          data: { key: a.keyName, chords: a.suggestedProgression.map((c) => c.name) },
        };
      }
      default:
        return { ok: false, message: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
