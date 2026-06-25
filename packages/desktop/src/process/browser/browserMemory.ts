/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lightweight persistent memory + persona for the web-browsing agent
 * (Requirement 1 — "personal" web agent). Two concerns, one small JSON file:
 *
 * - **Persona** — a global, user-authored instruction prepended to the agent's
 *   system prompt every turn (e.g. "Always answer in Vietnamese, be concise,
 *   never make purchases without asking"). Gives the agent a stable personality.
 * - **Site memory** — short notes the agent (or user) keeps per web origin
 *   (host), so on a return visit the agent recalls useful facts (e.g. login
 *   layout quirks, where the search box is). Notes are capped so the file never
 *   bloats.
 *
 * Stored as `browser-agent-memory.json` in the Electron `userData` dir, next to
 * the other Main-process state (mirrors `resourceState.ts`). The fs layer and
 * directory resolution are injectable so tests target a temp dir without a live
 * Electron `app`. Writes are atomic (tmp file + rename, `mode: 0o600`).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app } from 'electron';
import * as nodeFs from 'node:fs';
import * as path from 'node:path';

/** Name of the persisted memory file under the app data directory. */
const MEMORY_FILE = 'browser-agent-memory.json';

/** Max notes kept per site (oldest dropped first). */
const MAX_NOTES_PER_SITE = 20;

/** Max characters kept for the persona (defensive cap). */
const MAX_PERSONA_CHARS = 4000;

/** A single timestamped note about a site. */
export type SiteNote = {
  /** The note text. */
  text: string;
  /** Unix-ms timestamp when the note was recorded. */
  at: number;
};

/** The full persisted shape. */
export type BrowserMemoryData = {
  /** Global persona instruction prepended to the agent's system prompt. */
  persona: string;
  /** Per-origin (host) notes the agent recalls on return visits. */
  sites: Record<string, SiteNote[]>;
};

/** Minimal subset of `fs/promises` used here (injectable for tests). */
export type BrowserMemoryFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

/** Injected dependencies for {@link createBrowserMemory}. */
export type BrowserMemoryDeps = {
  /** Filesystem layer. Defaults to `node:fs/promises`. */
  fs?: BrowserMemoryFs;
  /** Directory holding the memory file. Defaults to Electron `userData`. */
  dir?: string;
};

/** Public contract of the browser-agent memory store. */
export type IBrowserMemory = {
  /** Read the full snapshot (persona + all site notes). */
  read: () => Promise<BrowserMemoryData>;
  /** Read just the persona instruction (empty string when unset). */
  getPersona: () => Promise<string>;
  /** Replace the persona instruction. */
  setPersona: (persona: string) => Promise<void>;
  /** Read the notes for a host (most-recent last; empty when none). */
  getSiteNotes: (host: string) => Promise<SiteNote[]>;
  /** Append a note for a host, trimming to the per-site cap. */
  addSiteNote: (host: string, text: string) => Promise<void>;
  /** Clear all notes for a host. */
  clearSite: (host: string) => Promise<void>;
};

/** The empty default snapshot. */
const emptyData = (): BrowserMemoryData => ({ persona: '', sites: {} });

/** Extract the host (origin key) from a URL; returns '' for unparseable input. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

/**
 * Create a browser-agent memory store.
 *
 * @param deps Injected fs + directory (both optional; production uses defaults).
 */
export const createBrowserMemory = (deps: BrowserMemoryDeps = {}): IBrowserMemory => {
  const fs = deps.fs ?? (nodeFs.promises as unknown as BrowserMemoryFs);
  const resolveDir = (): string => deps.dir ?? app.getPath('userData');
  const filePath = (): string => path.join(resolveDir(), MEMORY_FILE);

  const read = async (): Promise<BrowserMemoryData> => {
    try {
      const raw = await fs.readFile(filePath(), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<BrowserMemoryData>;
      return {
        persona: typeof parsed.persona === 'string' ? parsed.persona : '',
        sites: parsed.sites && typeof parsed.sites === 'object' ? parsed.sites : {},
      };
    } catch {
      // Missing / unreadable / malformed file → start fresh (non-fatal).
      return emptyData();
    }
  };

  const write = async (data: BrowserMemoryData): Promise<void> => {
    const dir = resolveDir();
    await fs.mkdir(dir, { recursive: true });
    const target = filePath();
    const tmp = `${target}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmp, target);
  };

  const getPersona = async (): Promise<string> => (await read()).persona;

  const setPersona = async (persona: string): Promise<void> => {
    const data = await read();
    data.persona = persona.slice(0, MAX_PERSONA_CHARS);
    await write(data);
  };

  const getSiteNotes = async (host: string): Promise<SiteNote[]> => {
    if (!host) return [];
    return (await read()).sites[host] ?? [];
  };

  const addSiteNote = async (host: string, text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!host || trimmed.length === 0) return;
    const data = await read();
    const notes = data.sites[host] ?? [];
    notes.push({ text: trimmed, at: Date.now() });
    // Keep only the most recent N notes for this site.
    data.sites[host] = notes.slice(-MAX_NOTES_PER_SITE);
    await write(data);
  };

  const clearSite = async (host: string): Promise<void> => {
    if (!host) return;
    const data = await read();
    if (data.sites[host]) {
      delete data.sites[host];
      await write(data);
    }
  };

  return { read, getPersona, setPersona, getSiteNotes, addSiteNote, clearSite };
};
