/**
 * Headless engine commands.
 *
 * Every musical operation is a pure function over a Project. The user UI calls
 * these on click; the agent (via MCP) calls the exact same functions. Both
 * planes converge here, so a song edited by a human and by the agent stay
 * consistent. No UI, no audio device, no Node/DOM — just data transforms.
 *
 * Functions return a NEW project (immutable update) so the caller controls
 * persistence and undo/redo.
 */

import { createEffect, createPatternClip, createTrack } from '../shared/factory';
import { newId } from '../shared/ids';
import type { Clip, Effect, EffectKind, Note, Project, Step, Track, TrackType } from '../shared/schema';

/** Clamp helper for normalized/bounded params. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function replaceTrack(project: Project, trackId: string, update: (track: Track) => Track): Project {
  let found = false;
  const tracks = project.tracks.map((t) => {
    if (t.id !== trackId) return t;
    found = true;
    return update(t);
  });
  if (!found) throw new Error(`Track not found: ${trackId}`);
  return { ...project, tracks };
}

function replaceClip(track: Track, clipId: string, update: (clip: Clip) => Clip): Track {
  let found = false;
  const clips = track.clips.map((c) => {
    if (c.id !== clipId) return c;
    found = true;
    return update(c);
  });
  if (!found) throw new Error(`Clip not found: ${clipId}`);
  return { ...track, clips };
}

// ---- Transport / song-level ----

export function setTempo(project: Project, bpm: number): Project {
  if (bpm <= 0 || !Number.isFinite(bpm)) throw new Error(`Invalid tempo: ${bpm}`);
  return { ...project, tempo: bpm };
}

export function setTimeSignature(project: Project, numerator: number, denominator: number): Project {
  if (numerator <= 0 || denominator <= 0) throw new Error('Invalid time signature');
  return { ...project, timeSignature: [numerator, denominator] };
}

export function renameProject(project: Project, name: string): Project {
  return { ...project, name };
}

// ---- Tracks ----

export function addTrack(
  project: Project,
  name: string,
  type: TrackType = 'instrument'
): { project: Project; trackId: string } {
  const track = createTrack(name, type, project.tracks.length);
  return { project: { ...project, tracks: [...project.tracks, track] }, trackId: track.id };
}

export function removeTrack(project: Project, trackId: string): Project {
  const tracks = project.tracks.filter((t) => t.id !== trackId);
  if (tracks.length === project.tracks.length) throw new Error(`Track not found: ${trackId}`);
  return { ...project, tracks };
}

export function renameTrack(project: Project, trackId: string, name: string): Project {
  return replaceTrack(project, trackId, (t) => ({ ...t, name }));
}

export function setTrackVolume(project: Project, trackId: string, volumeDb: number): Project {
  return replaceTrack(project, trackId, (t) => ({ ...t, volumeDb: clamp(volumeDb, -60, 12) }));
}

export function setTrackPan(project: Project, trackId: string, pan: number): Project {
  return replaceTrack(project, trackId, (t) => ({ ...t, pan: clamp(pan, -1, 1) }));
}

export function setTrackMute(project: Project, trackId: string, mute: boolean): Project {
  return replaceTrack(project, trackId, (t) => ({ ...t, mute }));
}

export function setTrackSolo(project: Project, trackId: string, solo: boolean): Project {
  return replaceTrack(project, trackId, (t) => ({ ...t, solo }));
}

export function assignSampler(project: Project, trackId: string, sampleId: string): Project {
  return replaceTrack(project, trackId, (t) => ({ ...t, instrument: { kind: 'sampler', sampleId } }));
}

// ---- Clips ----

export function addPatternClip(
  project: Project,
  trackId: string,
  startBeat: number,
  lengthBeat: number
): { project: Project; clipId: string } {
  const clip = createPatternClip(startBeat, lengthBeat);
  const next = replaceTrack(project, trackId, (t) => ({ ...t, clips: [...t.clips, clip] }));
  return { project: next, clipId: clip.id };
}

export function addAudioClip(
  project: Project,
  trackId: string,
  sampleId: string,
  startBeat: number,
  lengthBeat: number
): { project: Project; clipId: string } {
  const clip: Clip = {
    id: newId(),
    startBeat,
    lengthBeat,
    kind: 'audio',
    audio: { sampleId, offsetSec: 0, gainDb: 0, tune: null },
  };
  const next = replaceTrack(project, trackId, (t) => ({ ...t, clips: [...t.clips, clip] }));
  return { project: next, clipId: clip.id };
}

export function removeClip(project: Project, trackId: string, clipId: string): Project {
  return replaceTrack(project, trackId, (t) => {
    const clips = t.clips.filter((c) => c.id !== clipId);
    if (clips.length === t.clips.length) throw new Error(`Clip not found: ${clipId}`);
    return { ...t, clips };
  });
}

export function moveClip(project: Project, trackId: string, clipId: string, startBeat: number): Project {
  return replaceTrack(project, trackId, (t) => replaceClip(t, clipId, (c) => ({ ...c, startBeat })));
}

// ---- Step sequencer ----

/** Toggle/set a step in a pattern clip. velocity 0 removes the step. */
export function setStep(
  project: Project,
  trackId: string,
  clipId: string,
  step: number,
  sampleId: string | null,
  velocity: number
): Project {
  return replaceTrack(project, trackId, (t) =>
    replaceClip(t, clipId, (c) => {
      if (c.kind !== 'pattern') throw new Error('setStep requires a pattern clip');
      const steps = (c.steps ?? []).filter((s) => s.step !== step);
      if (velocity > 0) {
        const entry: Step = { step, sampleId, velocity: clamp(Math.round(velocity), 1, 127) };
        steps.push(entry);
        steps.sort((a, b) => a.step - b.step);
      }
      return { ...c, steps };
    })
  );
}

// ---- Piano roll / MIDI notes ----

export function addNote(project: Project, trackId: string, clipId: string, note: Note): Project {
  return replaceTrack(project, trackId, (t) =>
    replaceClip(t, clipId, (c) => {
      if (c.kind !== 'midi') throw new Error('addNote requires a midi clip');
      const safe: Note = {
        pitch: clamp(Math.round(note.pitch), 0, 127),
        startBeat: note.startBeat,
        lengthBeat: Math.max(0, note.lengthBeat),
        velocity: clamp(Math.round(note.velocity), 1, 127),
      };
      return { ...c, notes: [...(c.notes ?? []), safe] };
    })
  );
}

// ---- Effects (mixer inserts) ----

export function addEffect(project: Project, trackId: string, kind: EffectKind): { project: Project; effectId: string } {
  const effect = createEffect(kind);
  const next = replaceTrack(project, trackId, (t) => ({ ...t, effects: [...t.effects, effect] }));
  return { project: next, effectId: effect.id };
}

export function setEffectParam(
  project: Project,
  trackId: string,
  effectId: string,
  param: string,
  value: number
): Project {
  return replaceTrack(project, trackId, (t) => {
    let found = false;
    const effects: Effect[] = t.effects.map((e) => {
      if (e.id !== effectId) return e;
      found = true;
      return { ...e, params: { ...e.params, [param]: value } };
    });
    if (!found) throw new Error(`Effect not found: ${effectId}`);
    return { ...t, effects };
  });
}

export function setMasterVolume(project: Project, volumeDb: number): Project {
  return { ...project, master: { ...project.master, volumeDb: clamp(volumeDb, -60, 12) } };
}
