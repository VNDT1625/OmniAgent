/**
 * Lightweight structural validation for a Project loaded from disk.
 *
 * Intentionally dependency-free (no zod) to keep the shared layer importable
 * everywhere. Returns a list of human-readable errors; empty list means valid.
 * The engine layer may apply stricter, per-effect parameter checks on top.
 */

import { CURRENT_SCHEMA_VERSION } from './schema';
import type { Project } from './schema';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function validateClip(clip: unknown, path: string, errors: string[]): void {
  if (!isObject(clip)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (typeof clip.id !== 'string') errors.push(`${path}.id must be a string`);
  if (!isFiniteNumber(clip.startBeat)) errors.push(`${path}.startBeat must be a number`);
  if (!isFiniteNumber(clip.lengthBeat)) errors.push(`${path}.lengthBeat must be a number`);
  const kind = clip.kind;
  if (kind !== 'pattern' && kind !== 'midi' && kind !== 'audio') {
    errors.push(`${path}.kind must be one of pattern|midi|audio`);
  }
}

function validateTrack(track: unknown, path: string, errors: string[]): void {
  if (!isObject(track)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (typeof track.id !== 'string') errors.push(`${path}.id must be a string`);
  if (typeof track.name !== 'string') errors.push(`${path}.name must be a string`);
  const type = track.type;
  if (type !== 'instrument' && type !== 'audio' && type !== 'midi') {
    errors.push(`${path}.type must be one of instrument|audio|midi`);
  }
  if (!isFiniteNumber(track.volumeDb)) errors.push(`${path}.volumeDb must be a number`);
  if (!isFiniteNumber(track.pan)) errors.push(`${path}.pan must be a number`);
  if (!Array.isArray(track.clips)) {
    errors.push(`${path}.clips must be an array`);
  } else {
    (track.clips as unknown[]).forEach((c, i) => validateClip(c, `${path}.clips[${i}]`, errors));
  }
}

export function validateProject(input: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(input)) {
    return ['project must be an object'];
  }
  if (input.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be ${CURRENT_SCHEMA_VERSION} (got ${String(input.schemaVersion)}); run migration first`
    );
  }
  if (typeof input.id !== 'string') errors.push('id must be a string');
  if (typeof input.name !== 'string') errors.push('name must be a string');
  if (!isFiniteNumber(input.tempo) || (input.tempo as number) <= 0) errors.push('tempo must be a positive number');
  if (!Array.isArray(input.timeSignature) || input.timeSignature.length !== 2) {
    errors.push('timeSignature must be a [number, number] tuple');
  }
  if (!isFiniteNumber(input.sampleRate)) errors.push('sampleRate must be a number');
  if (!Array.isArray(input.tracks)) {
    errors.push('tracks must be an array');
  } else {
    (input.tracks as unknown[]).forEach((t, i) => validateTrack(t, `tracks[${i}]`, errors));
  }
  if (!Array.isArray(input.samples)) errors.push('samples must be an array');
  return errors;
}

export function isValidProject(input: unknown): input is Project {
  return validateProject(input).length === 0;
}
