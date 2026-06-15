/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Artifact helpers shared by the Automation connectors.
 *
 * App-function nodes (Make Video, Editor) emit an {@link Artifact} as their
 * output; downstream cloud/social nodes consume it. Because the engine threads
 * the *whole* previous-node output into the next node's `input`, these helpers
 * normalise that opaque `input` back into an {@link Artifact} (or its file path)
 * so a connector can find "the file the previous step produced" without the user
 * having to re-type a path.
 *
 * `{{input}}` template substitution lives here too so every connector renders
 * caption/subject/destination strings consistently.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Artifact } from '../automationTypes';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Type guard: a plausibly-complete {@link Artifact} (must at least carry a path). */
export const isArtifact = (v: unknown): v is Artifact => isObject(v) && typeof v.path === 'string' && v.path.length > 0;

/**
 * Pull an {@link Artifact} out of an opaque pipeline `input`. Accepts a bare
 * artifact, an `{ artifact }` wrapper, or an `{ artifacts: [...] }` list (last
 * one wins). Returns `null` when no artifact can be found.
 */
export const artifactFromInput = (input: unknown): Artifact | null => {
  if (isArtifact(input)) return input;
  if (isObject(input)) {
    if (isArtifact(input.artifact)) return input.artifact;
    if (Array.isArray(input.artifacts)) {
      const last = [...input.artifacts].toReversed().find(isArtifact);
      if (last) return last;
    }
  }
  return null;
};

/**
 * Resolve the source file for an upload/publish node: an explicit configured
 * path wins, otherwise the previous step's artifact path. Throws a clear error
 * when neither is available so the run fails fast with an actionable message.
 */
export const resolveSourcePath = (explicitPath: string | undefined, input: unknown, nodeName: string): string => {
  const fromConfig = typeof explicitPath === 'string' ? explicitPath.trim() : '';
  if (fromConfig.length > 0) return fromConfig;
  const artifact = artifactFromInput(input);
  if (artifact) return artifact.path;
  throw new Error(
    `"${nodeName}" has no file to use: set a source path or place an app step (Make Video / Editor) before it.`
  );
};

/** Substitute every `{{input}}` occurrence with the stringified pipeline input. */
export const substituteInput = (template: string, input: unknown): string => {
  const value =
    typeof input === 'string'
      ? input
      : isArtifact(input)
        ? (input.title ?? input.path)
        : input == null
          ? ''
          : JSON.stringify(input);
  return String(template ?? '').replace(/\{\{input\}\}/g, value);
};

/** Best-effort MIME type from a file extension (covers the media we produce). */
export const mimeFromPath = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  const table: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
  };
  return table[ext] ?? 'application/octet-stream';
};

/** Read a file's bytes, throwing a connector-friendly error when it is missing. */
export const readArtifactBytes = async (filePath: string): Promise<Buffer> => {
  try {
    return await fs.promises.readFile(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read file "${filePath}": ${message}`, { cause: error });
  }
};

/** Build an {@link Artifact} for a produced local file (path + derived MIME). */
export const makeArtifact = (filePath: string, title?: string | null, url?: string | null): Artifact => ({
  path: filePath,
  mimeType: mimeFromPath(filePath),
  title: title ?? path.basename(filePath),
  url: url ?? null,
});
