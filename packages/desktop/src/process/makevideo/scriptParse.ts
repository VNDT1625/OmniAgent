/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Robust scene-script extraction for the Make Video LLM step.
 *
 * LLMs — especially local models (Ollama / LM Studio) and CLI agents that wrap
 * the reply in prose — return JSON that is *almost* valid: wrapped in ```json
 * fences, embedded in chatter, padded with trailing commas, or using smart
 * quotes. This module turns that into a clean {@link Scene}[] with a layered
 * strategy:
 *
 *  1. Strip code fences + zero-width chars, locate the first balanced top-level
 *     `[ … ]` array (bracket-aware: brackets *inside* strings are ignored so a
 *     `"shot [variant]"` prompt never truncates the scan early).
 *  2. `JSON.parse` the slice. On failure, run a conservative repair pass
 *     (trailing commas, smart quotes) and parse again.
 *  3. Map each element to a Scene, tolerating missing fields per-scene.
 *
 * Pure (no network/provider/Node APIs beyond types) so it is fully unit-tested
 * in isolation.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { Scene } from './makeVideoTypes';

/** Remove ```json fences, BOM, and zero-width characters that break JSON.parse. */
const stripWrappers = (reply: string): string =>
  reply
    .replace(/```(?:json|javascript|js)?/gi, '')
    .replace(/```/g, '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');

/**
 * Find the first balanced top-level `[ … ]` array, ignoring brackets that
 * appear inside double-quoted strings (with escape handling). Returns the raw
 * slice including the outer brackets, or `null` when none is found.
 */
export const extractJsonArray = (text: string): string | null => {
  const start = text.indexOf('[');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
};

/**
 * Conservative JSON repair for common LLM mistakes. Only touches structure
 * *outside* of strings: removes trailing commas before `]`/`}`. Smart quotes are
 * normalised globally (safe for prose-free scene JSON). Never attempts to "fix"
 * content — a genuinely broken reply still throws downstream.
 */
export const repairJsonText = (text: string): string => {
  const normalised = text
    .replace(/[\u201C\u201D]/g, '"') // “ ” → "
    .replace(/[\u2018\u2019]/g, "'"); // ‘ ’ → '

  // Strip trailing commas (`, ]` / `, }`) that are outside of strings.
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < normalised.length; i += 1) {
    const ch = normalised[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      // Look ahead past whitespace; drop the comma if the next token closes.
      let j = i + 1;
      while (j < normalised.length && /\s/.test(normalised[j])) j += 1;
      if (normalised[j] === ']' || normalised[j] === '}') continue;
    }
    out += ch;
  }
  return out;
};

/** Parse a JSON array slice, retrying once through {@link repairJsonText}. */
const parseArraySlice = (slice: string): unknown => {
  try {
    return JSON.parse(slice);
  } catch (firstError) {
    try {
      return JSON.parse(repairJsonText(slice));
    } catch {
      const detail = firstError instanceof Error ? firstError.message : String(firstError);
      throw new Error(`Failed to parse the scene JSON array: ${detail}`, { cause: firstError });
    }
  }
};

/**
 * Extract the first JSON array from a model reply and map it to {@link Scene}s.
 *
 * `sceneCount` is the requested count; callers may compare it against the
 * returned length to surface a mismatch. Indices are always assigned
 * sequentially (0-based) regardless of any `index` the model invented.
 *
 * Throws a clear, user-facing error when no array is found, the slice cannot be
 * parsed (even after repair), or no element carries any recognisable field.
 */
export const parseScenes = (reply: string, sceneCount: number, newId: () => string): Scene[] => {
  if (typeof reply !== 'string' || reply.trim().length === 0) {
    throw new Error('The model returned an empty response; expected a JSON array of scenes.');
  }

  const unfenced = stripWrappers(reply);
  const slice = extractJsonArray(unfenced);
  if (slice === null) {
    throw new Error('Could not find a JSON array of scenes in the model reply.');
  }

  const parsed = parseArraySlice(slice);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('The model reply did not contain a non-empty JSON array of scenes.');
  }

  const scenes = parsed.map((raw, index): Scene => {
    const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title : '';
    const narration = typeof obj.narration === 'string' ? obj.narration : '';
    const imagePrompt = typeof obj.imagePrompt === 'string' ? obj.imagePrompt : '';
    if (title === '' && narration === '' && imagePrompt === '') {
      throw new Error(
        `Scene ${index + 1} is missing all of title/narration/imagePrompt; the reply was not in the expected shape.`
      );
    }
    return {
      id: newId(),
      index,
      title,
      narration,
      imagePrompt,
      imagePath: null,
      imageError: null,
    };
  });

  void sceneCount; // Requested count is advisory; callers decide on mismatch.
  return scenes;
};
