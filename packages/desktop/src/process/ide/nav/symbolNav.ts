/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers for IDE symbol navigation (go-to-definition / find-references).
 * No `fs`, no IPC — just the regexes + scanning logic, so it is fully testable.
 * The bridge layer walks the repo and feeds file contents here.
 *
 * This is a lightweight, language-agnostic heuristic (not a full type-aware
 * resolver): it finds DECLARATION sites of an identifier (function/class/const/
 * let/var/type/interface/enum/import-binding) for "go to definition", and plain
 * word-boundary occurrences for "find references". Good enough to jump around a
 * TS/JS codebase without an LSP, and cheap enough to run on demand.
 */

/** A located symbol hit (definition or reference). */
export type SymbolHit = {
  /** 1-based line number. */
  line: number;
  /** 1-based column of the identifier. */
  column: number;
  /** The full line text (trimmed), for a preview. */
  text: string;
};

/** Whether `name` is a plausible JS/TS identifier (so we don't grep junk). */
export const isIdentifier = (name: string): boolean => /^[A-Za-z_$][\w$]*$/.test(name);

/**
 * Build the set of declaration-site regexes for an identifier. Each matches a
 * line that DECLARES `name`. Anchored loosely (allow leading `export`/modifiers).
 */
export const declarationPatterns = (name: string): RegExp[] => {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    // function / async function / generator
    new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s+${n}\\b`),
    // class / abstract class
    new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${n}\\b`),
    // const / let / var binding (incl. arrow fn)
    new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${n}\\b`),
    // type alias / interface / enum
    new RegExp(`\\b(?:export\\s+)?(?:type|interface|enum)\\s+${n}\\b`),
    // import binding: import { name } / import name / import { x as name }
    new RegExp(`\\bimport\\b[^;]*\\b${n}\\b[^;]*from`),
    // object/class method or property shorthand at declaration: `name(` / `name:` / `name =`
    new RegExp(`(?:^|[\\s,{(])${n}\\s*[:(=]`),
  ];
};

/** Whether a line declares `name` (matches ANY declaration pattern). */
export const isDeclarationLine = (line: string, name: string): boolean =>
  declarationPatterns(name).some((re) => re.test(line));

/** Column (1-based) of the first whole-word occurrence of `name` in `line`, or 1. */
export const columnOf = (line: string, name: string): number => {
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const m = re.exec(line);
  return m ? m.index + 1 : 1;
};

/**
 * Scan one file's content for DECLARATIONS of `name`. Returns 0+ hits (a file
 * can declare a name once, but overloads/redeclarations are possible).
 */
export const findDeclarations = (content: string, name: string): SymbolHit[] => {
  if (!isIdentifier(name)) return [];
  const out: SymbolHit[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (isDeclarationLine(line, name)) {
      out.push({ line: i + 1, column: columnOf(line, name), text: line.trim().slice(0, 240) });
    }
  }
  return out;
};

/** Scan one file's content for all whole-word REFERENCES of `name`. */
export const findReferences = (content: string, name: string): SymbolHit[] => {
  if (!isIdentifier(name)) return [];
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const out: SymbolHit[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    const m = re.exec(line);
    if (m) out.push({ line: i + 1, column: m.index + 1, text: line.trim().slice(0, 240) });
  }
  return out;
};

/** Extract the identifier at a 0-based offset in a line (the word under cursor). */
export const wordAt = (line: string, offset: number): string | null => {
  if (offset < 0 || offset > line.length) return null;
  let start = offset;
  let end = offset;
  const isWord = (ch: string): boolean => /[\w$]/.test(ch);
  while (start > 0 && isWord(line[start - 1])) start--;
  while (end < line.length && isWord(line[end])) end++;
  const word = line.slice(start, end);
  return word.length > 0 && isIdentifier(word) ? word : null;
};
