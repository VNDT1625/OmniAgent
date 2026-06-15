/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PURE command-remap knowledge for Smart Fix.
 *
 * Maps a deprecated/renamed program to its replacement plus an update link, so
 * when a command fails the terminal can suggest the modern equivalent (e.g.
 * `gemini` → `agi`). A small built-in SEED covers known renames and works
 * offline; an injected async resolver (backed by Realtime Knowledge) can enrich
 * or override it from the web over time.
 *
 * No I/O in this module (the resolver is injected).
 */

/** A program remap suggestion. */
export type Remap = {
  /** The deprecated program (lowercased base name). */
  from: string;
  /** The replacement program. */
  to: string;
  /** Optional link to the update/migration page. */
  updateUrl?: string;
  /** Where this remap came from (for display/trust). */
  source: 'seed' | 'realtime';
};

/**
 * Built-in seed remaps. Keep small + high-confidence; RTK is the place to grow
 * this over time. Keyed by the deprecated program (lowercased).
 */
export const SEED_REMAPS: Readonly<Record<string, Omit<Remap, 'from' | 'source'>>> = {
  gemini: { to: 'agi', updateUrl: 'https://github.com/google-gemini/gemini-cli/releases' },
};

/** An async resolver that returns a replacement program for `program`, or null. */
export type RemapResolver = (program: string) => Promise<Omit<Remap, 'from' | 'source'> | null>;

/**
 * Look up a remap for `program`: the injected resolver (RTK) wins when it
 * returns something, otherwise the built-in seed. Returns null when neither
 * knows the program (so the caller shows a plain error, no remap).
 *
 * @param program The failing command's program token (already base-name lowercased).
 * @param resolver Optional RTK-backed resolver.
 */
export const lookupRemap = async (program: string, resolver?: RemapResolver): Promise<Remap | null> => {
  const key = program.trim().toLowerCase();
  if (key.length === 0) return null;
  if (resolver) {
    try {
      const fromRtk = await resolver(key);
      if (fromRtk && fromRtk.to && fromRtk.to !== key) {
        return { from: key, source: 'realtime', ...fromRtk };
      }
    } catch {
      // fall through to seed
    }
  }
  const seed = SEED_REMAPS[key];
  if (seed && seed.to !== key) return { from: key, source: 'seed', ...seed };
  return null;
};
