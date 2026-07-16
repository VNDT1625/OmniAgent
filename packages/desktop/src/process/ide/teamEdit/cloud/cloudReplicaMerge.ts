/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Pure, deterministic three-way text merge used by cloud workspace replicas. */

import { diffArrays } from 'diff';

type LineEdit = {
  start: number;
  end: number;
  lines: string[];
};

export type ThreeWayMergeResult =
  | { ok: true; content: string; autoMerged: boolean }
  | { ok: false; content: string; reason: 'overlap' };

const splitLines = (value: string): string[] => value.split('\n');

const toLineEdits = (base: string[], variant: string[]): LineEdit[] => {
  const changes = diffArrays(base, variant);
  const edits: LineEdit[] = [];
  let baseCursor = 0;
  let index = 0;

  while (index < changes.length) {
    const change = changes[index];
    if (!change.added && !change.removed) {
      baseCursor += change.value.length;
      index += 1;
      continue;
    }

    const start = baseCursor;
    const replacement: string[] = [];
    while (index < changes.length && (changes[index].added || changes[index].removed)) {
      const changed = changes[index];
      if (changed.removed) baseCursor += changed.value.length;
      if (changed.added) replacement.push(...changed.value);
      index += 1;
    }
    edits.push({ start, end: baseCursor, lines: replacement });
  }

  return edits;
};

const sameEdit = (left: LineEdit, right: LineEdit): boolean =>
  left.start === right.start && left.end === right.end && left.lines.join('\n') === right.lines.join('\n');

const overlaps = (left: LineEdit, right: LineEdit): boolean => {
  if (left.start === left.end && right.start === right.end) return left.start === right.start;
  if (left.start === left.end) return left.start >= right.start && left.start <= right.end;
  if (right.start === right.end) return right.start >= left.start && right.start <= left.end;
  return Math.max(left.start, right.start) < Math.min(left.end, right.end);
};

const applyEdits = (base: string[], edits: LineEdit[]): string => {
  const output = [...base];
  const ordered = [...edits].toSorted((left, right) => right.start - left.start || right.end - left.end);
  for (const edit of ordered) output.splice(edit.start, edit.end - edit.start, ...edit.lines);
  return output.join('\n');
};

const conflictText = (local: string, remote: string): string =>
  ['<<<<<<< LOCAL', local, '=======', remote, '>>>>>>> REMOTE'].join('\n');

/**
 * Merge two descendants of the same base text.
 *
 * Disjoint line edits merge automatically. Overlapping edits are returned as a
 * conflict document so callers can persist all three versions without data loss.
 */
export const mergeText3 = (base: string, local: string, remote: string): ThreeWayMergeResult => {
  if (local === remote) return { ok: true, content: local, autoMerged: false };
  if (local === base) return { ok: true, content: remote, autoMerged: false };
  if (remote === base) return { ok: true, content: local, autoMerged: false };

  const baseLines = splitLines(base);
  const localEdits = toLineEdits(baseLines, splitLines(local));
  const remoteEdits = toLineEdits(baseLines, splitLines(remote));
  const acceptedRemote: LineEdit[] = [];

  for (const remoteEdit of remoteEdits) {
    const touching = localEdits.find((localEdit) => overlaps(localEdit, remoteEdit));
    if (!touching) {
      acceptedRemote.push(remoteEdit);
      continue;
    }
    if (!sameEdit(touching, remoteEdit)) return { ok: false, content: conflictText(local, remote), reason: 'overlap' };
  }

  return {
    ok: true,
    content: applyEdits(baseLines, [...localEdits, ...acceptedRemote]),
    autoMerged: true,
  };
};
