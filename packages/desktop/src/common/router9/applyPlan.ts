/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers for *applying* a 9Router {@link ConnectorPlan} to disk.
 *
 * The plan engine (`connectorEngine.ts`) decides WHAT to write; this module
 * holds the format-agnostic pieces of HOW to merge it with an existing file —
 * home-directory expansion and a JSON deep-merge where the incoming (9Router)
 * keys win. The actual filesystem side effects live in the Main-process applier
 * (`process/router9/router9Applier.ts`); keeping these helpers pure makes them
 * trivially unit-testable and safe to import from either process.
 *
 * No Node APIs, no I/O — `homeDir` is injected so even path expansion stays pure.
 */

/** A plain JSON object (the only shape we deep-merge). */
type JsonObject = Record<string, unknown>;

/** True for a non-null, non-array object — the only thing we recurse into. */
const isPlainObject = (value: unknown): value is JsonObject => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * Expand a leading `~` (or `~/…`) to an absolute path under `homeDir`.
 *
 * Only a leading tilde is expanded — a `~` anywhere else is left untouched so we
 * never corrupt a legitimate path segment. `homeDir` is passed in (never read
 * from the environment here) to keep this function pure.
 */
export const expandHome = (filePath: string, homeDir: string): string => {
  if (filePath === '~') return homeDir;
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return `${homeDir}/${filePath.slice(2)}`;
  }
  return filePath;
};

/**
 * Deep-merge two JSON values, with `incoming` taking precedence.
 *
 * - Two objects → merged key-by-key (recursively).
 * - Anything else (arrays, primitives, type mismatch) → `incoming` replaces
 *   `existing` wholesale. We deliberately do NOT concatenate arrays: a provider
 *   list should be replaced as a unit, not appended to, to avoid duplicates.
 *
 * Neither argument is mutated — a fresh object graph is returned for objects.
 */
export const deepMerge = (existing: unknown, incoming: unknown): unknown => {
  if (!isPlainObject(existing) || !isPlainObject(incoming)) {
    return incoming;
  }
  const result: JsonObject = { ...existing };
  for (const key of Object.keys(incoming)) {
    result[key] = key in existing ? deepMerge(existing[key], incoming[key]) : incoming[key];
  }
  return result;
};

/**
 * Merge a config file's incoming JSON `content` with whatever is already on
 * disk (`existingRaw`, possibly `undefined` when the file is absent) according
 * to a {@link ConfigFilePlan}'s `mergeStrategy`.
 *
 * Returns the final text to write, or `null` when the strategy says "leave the
 * existing file alone" (`createIfMissing` on an existing file). Only JSON files
 * are deep-merged; `text`/`toml` formats fall back to a straight replace because
 * we cannot safely parse+merge them here.
 *
 * @throws if an existing JSON file cannot be parsed (the caller should surface
 *   this so the user can fix or back up their file rather than lose it).
 */
export const mergeConfigContent = (params: {
  format: 'json' | 'toml' | 'text';
  mergeStrategy: 'replace' | 'deepMerge' | 'createIfMissing';
  incomingContent: string;
  existingRaw?: string;
}): string | null => {
  const { format, mergeStrategy, incomingContent, existingRaw } = params;
  const fileExists = existingRaw !== undefined;

  if (mergeStrategy === 'createIfMissing') {
    return fileExists ? null : incomingContent;
  }
  if (mergeStrategy === 'replace' || format !== 'json' || !fileExists) {
    return incomingContent;
  }

  // deepMerge on an existing JSON file.
  let existingJson: unknown;
  try {
    existingJson = existingRaw.trim() === '' ? {} : JSON.parse(existingRaw);
  } catch (error) {
    throw new Error(`Existing config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const incomingJson = JSON.parse(incomingContent) as unknown;
  const merged = deepMerge(existingJson, incomingJson);
  return `${JSON.stringify(merged, null, 2)}\n`;
};
