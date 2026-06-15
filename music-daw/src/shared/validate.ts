/**
 * Lightweight runtime validation for ProjectSchema.
 *
 * We avoid pulling a schema library (zod, etc.) at the scaffold stage so this
 * stays dependency-free and usable in both processes. The goal is to catch
 * corrupt / hand-edited project files before they reach the engine, not to be a
 * full JSON-schema validator.
 */

import type { ProjectSchema, Track, Clip } from './schema.js';

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

const validateClip = (clip: Clip, path: string, errors: string[]): void => {
  if (!isString(clip.id)) errors.push(`${path}.id must be a string`);
  if (!isFiniteNumber(clip.startBeat)) errors.push(`${path}.startBeat must be a number`);
  if (!isFiniteNumber(clip.lengthBeat) || clip.lengthBeat < 0) {
    errors.push(`${path}.lengthBeat must be a non-negative number`);
  }
  if (!['pattern', 'midi', 'audio'].includes(clip.kind)) {
    errors.push(`${path}.kind is invalid: ${String(clip.kind)}`);
  }
};

const validateTrack = (track: Track, path: string, errors: string[]): void => {
  if (!isString(track.id)) errors.push(`${path}.id must be a string`);
  if (!isString(track.name)) errors.push(`${path}.name must be a string`);
  if (!['instrument', 'audio', 'midi'].includes(track.type)) {
    errors.push(`${path}.type is invalid: ${String(track.type)}`);
  }
  if (!isBool(track.mute)) errors.push(`${path}.mute must be a boolean`);
  if (!isBool(track.solo)) errors.push(`${path}.solo must be a boolean`);
  if (!isFiniteNumber(track.volumeDb)) errors.push(`${path}.volumeDb must be a number`);
  if (!isFiniteNumber(track.pan) || track.pan < -1 || track.pan > 1) {
    errors.push(`${path}.pan must be between -1 and 1`);
  }
  if (!Array.isArray(track.clips)) {
    errors.push(`${path}.clips must be an array`);
  } else {
    track.clips.forEach((clip, i) => validateClip(clip, `${path}.clips[${i}]`, errors));
  }
  if (!Array.isArray(track.effects)) errors.push(`${path}.effects must be an array`);
};

export const validateProject = (data: unknown): ValidationResult => {
  const errors: string[] = [];

  if (typeof data !== 'object' || data === null) {
    return { ok: false, errors: ['project must be an object'] };
  }

  const p = data as Partial<ProjectSchema>;

  if (!isFiniteNumber(p.schemaVersion)) errors.push('schemaVersion must be a number');
  if (!isString(p.id)) errors.push('id must be a string');
  if (!isString(p.name)) errors.push('name must be a string');
  if (!isFiniteNumber(p.tempo) || (p.tempo ?? 0) <= 0) errors.push('tempo must be a positive number');
  if (!isFiniteNumber(p.sampleRate) || (p.sampleRate ?? 0) <= 0) {
    errors.push('sampleRate must be a positive number');
  }
  if (!Array.isArray(p.timeSignature) || p.timeSignature.length !== 2) {
    errors.push('timeSignature must be a [number, number] tuple');
  }
  if (!Array.isArray(p.tracks)) {
    errors.push('tracks must be an array');
  } else {
    p.tracks.forEach((track, i) => validateTrack(track, `tracks[${i}]`, errors));
  }
  if (!Array.isArray(p.samples)) errors.push('samples must be an array');
  if (typeof p.master !== 'object' || p.master === null) errors.push('master must be an object');

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
};
