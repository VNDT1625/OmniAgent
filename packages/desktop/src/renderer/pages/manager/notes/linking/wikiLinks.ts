/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Obsidian-style `[[wiki]]` link helpers for Learn notes (criterion 5.8).
 *
 * Supports the full Obsidian link grammar the user expects:
 * - **Plain title**: `[[Class Diagram]]` → the note titled "Class Diagram".
 * - **Path-style**: `[[c4/Class Diagram]]` → resolves by the LAST path segment
 *   ("Class Diagram") when no note has that exact full title, so a folder-like
 *   prefix (a "model" the note belongs to) still navigates to the right note.
 * - **Alias**: `[[Class Diagram|the class view]]` → links to "Class Diagram"
 *   but displays "the class view".
 *
 * Matching is case-insensitive and trims whitespace. All pure + renderer-only.
 */

import type { Note } from '@process/manager/managerTypes';

const WIKI_RE = /\[\[([^\]]+)\]\]/g;

/** A parsed wiki token: the link target (path/title) and an optional display alias. */
export type WikiToken = { target: string; alias?: string };

/** Split a raw `[[...]]` inner string into its target + optional `|alias`. */
export const parseWikiToken = (raw: string): WikiToken => {
  const pipe = raw.indexOf('|');
  if (pipe === -1) return { target: raw.trim() };
  return { target: raw.slice(0, pipe).trim(), alias: raw.slice(pipe + 1).trim() || undefined };
};

/** The last `/`-separated segment of a path-style target (or the whole target). */
const lastSegment = (target: string): string => {
  const parts = target.split('/').filter((p) => p.trim().length > 0);
  return (parts.length > 0 ? parts[parts.length - 1] : target).trim();
};

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Extract the link **targets** referenced in a note body (de-duplicated,
 * alias stripped). Used for backlinks + the graph, so two links to the same
 * note via different aliases count once.
 */
export const extractWikiTargets = (body: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  WIKI_RE.lastIndex = 0;
  while ((m = WIKI_RE.exec(body)) !== null) {
    const { target } = parseWikiToken(m[1]);
    const key = norm(target);
    if (target.length > 0 && !seen.has(key)) {
      seen.add(key);
      out.push(target);
    }
  }
  return out;
};

/**
 * Resolve a `[[target]]` to a Learn note. Tries, in order:
 * 1. exact full-target title match (`c4/Class Diagram` === a note's title),
 * 2. last-path-segment title match (`c4/Class Diagram` → "Class Diagram"),
 * so a folder/model-style prefix still finds the note. Case-insensitive.
 */
export const resolveWikiTarget = (target: string, notes: Note[]): Note | undefined => {
  const learn = notes.filter((n) => n.category === 'learn');
  const full = norm(target);
  const exact = learn.find((n) => norm(n.title ?? '') === full);
  if (exact) return exact;
  const seg = norm(lastSegment(target));
  if (seg.length === 0) return undefined;
  return learn.find((n) => norm(n.title ?? '') === seg);
};

/** Whether `target` resolves to an existing Learn note. */
export const wikiTargetExists = (target: string, notes: Note[]): boolean => Boolean(resolveWikiTarget(target, notes));

/**
 * Notes (learn) that link TO `note` (backlinks). A note's title is matched
 * against each other note's link targets using the same full/last-segment rule,
 * so a `[[c4/Class Diagram]]` link counts as a backlink to "Class Diagram".
 */
export const findBacklinks = (note: Note, notes: Note[]): Note[] => {
  if (note.category !== 'learn') return [];
  return notes.filter((n) => {
    if (n.category !== 'learn' || n.id === note.id) return false;
    return extractWikiTargets(n.body).some((target) => resolveWikiTarget(target, notes)?.id === note.id);
  });
};
