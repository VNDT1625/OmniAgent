/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared constants + pure helpers for the Workspace UI — the page that runs
 * several sub-agents in parallel, each on its own live frame.
 *
 * Renderer-only module: no Node.js APIs.
 */

import type { SurfaceSpec } from '@process/workspace/surfaceTypes';

/**
 * Timeout (ms) the renderer waits for a workspace IPC reply (cancel) before
 * treating the bridge as not wired. The long-lived `run` channel is exempt.
 */
export const WORKSPACE_BRIDGE_TIMEOUT_MS = 4000;

/** Debounce window (ms) for pushing a browser surface frame's bounds. */
export const SURFACE_BOUNDS_DEBOUNCE_MS = 120;

/** `localStorage` key remembering the model picked to drive workspace sub-agents. */
export const WORKSPACE_MODEL_STORAGE_KEY = 'aionui.workspace.model';

/** Matches a bare URL/host token inside free text (for surface detection). */
const URL_TOKEN = /\bhttps?:\/\/[^\s"'<>]+|\b[\w-]+\.(?:com|net|org|io|vn|dev|app|edu|gov)\b[^\s"'<>]*/gi;

/** Matches a file path / name token (has a known editable extension). */
const FILE_TOKEN =
  /\b[\w./\\-]+\.(?:md|txt|json|ya?ml|csv|js|ts|tsx|jsx|py|java|go|rs|c|cpp|h|html|css|xml|ini|log|docx?|xlsx?|pptx?)\b/gi;

/** Read the remembered workspace model (best-effort). */
export const loadWorkspaceModel = (): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(WORKSPACE_MODEL_STORAGE_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
};

/** Persist (or clear) the remembered workspace model (best-effort). */
export const saveWorkspaceModel = (model: string | null): void => {
  if (typeof window === 'undefined') return;
  try {
    if (model && model.length > 0) window.localStorage.setItem(WORKSPACE_MODEL_STORAGE_KEY, model);
    else window.localStorage.removeItem(WORKSPACE_MODEL_STORAGE_KEY);
  } catch {
    // Non-critical.
  }
};

/**
 * Heuristically split a free-text instruction into one or more {@link SurfaceSpec}s
 * so a single sentence like "search jobs on glassdoor.com and edit notes.md"
 * fans out into a browser surface + an editor surface running in parallel.
 *
 * The split is intentionally simple and predictable:
 * 1. find URL/host tokens → one browser surface each;
 * 2. find file tokens → one editor surface each;
 * 3. if neither is found, fall back to a single browser surface for the whole
 *    instruction (so the agent can search the web for it).
 *
 * The whole instruction is passed to every surface as context; each sub-agent
 * focuses on its own target. This keeps the parser dependency-free and lets the
 * model do the nuanced understanding.
 *
 * @param instruction The raw chat instruction.
 * @param model       The model id driving every sub-agent.
 */
export const parseSurfaceSpecs = (instruction: string, model: string): SurfaceSpec[] => {
  const text = instruction.trim();
  if (text.length === 0) return [];

  const urls = Array.from(text.matchAll(URL_TOKEN), (m) => m[0]);
  const files = Array.from(text.matchAll(FILE_TOKEN), (m) => m[0]).filter(
    // A token can match both regexes (e.g. "site.io/app.js"); keep only real
    // file-looking tokens that are not part of a captured URL.
    (file) => !urls.some((url) => url.includes(file))
  );

  const specs: SurfaceSpec[] = [];
  for (const url of urls) {
    specs.push({ kind: 'browser', url, instruction: text, model });
  }
  for (const filePath of files) {
    specs.push({ kind: 'editor', filePath, instruction: text, model });
  }

  if (specs.length === 0) {
    specs.push({ kind: 'browser', instruction: text, model });
  }
  return specs;
};

/** Generate a short unique id (run id / fallback keys). */
export const newRunId = (): string => {
  try {
    return crypto.randomUUID();
  } catch {
    return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
};
