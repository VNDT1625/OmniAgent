/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `catalog` — gathers the short descriptions of every skill + MCP tool into a
 * single in-memory catalog (Yêu cầu 7, criterion 7.1). The catalog is the input
 * to the filters (`keywordFilter`, `semanticFilter`) and the selection loop
 * (`toolSelector`); it is intentionally small (id + name + short description +
 * optional keywords) so it can be persisted to `tool-catalog.json` cheaply and
 * never bloats an agent's context.
 *
 * Sources are injected so this module needs no direct dependency on the skill
 * registry or the MCP servers: production wiring (Task 15.x) supplies loaders
 * that read skill metadata and each MCP tool's `description`; tests inject fakes.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import type { CatalogEntry } from './catalogTypes';

/** Loads the skill catalog entries (skill metadata → {@link CatalogEntry}). */
export type SkillCatalogLoader = () => Promise<CatalogEntry[]>;

/** Loads the MCP tool catalog entries (each tool's `description` → entry). */
export type McpToolCatalogLoader = () => Promise<CatalogEntry[]>;

/** Dependencies for {@link createCatalog}. */
export type CatalogDeps = {
  /** Loader for skill entries. */
  loadSkills: SkillCatalogLoader;
  /** Loader for MCP tool entries. */
  loadMcpTools: McpToolCatalogLoader;
  /** Optional persistence hook (e.g. write `tool-catalog.json`). */
  persist?: (entries: CatalogEntry[]) => Promise<void>;
};

/** Public contract of the catalog. */
export type ICatalog = {
  /** (Re)build the catalog from the injected sources and cache it. */
  refresh(): Promise<CatalogEntry[]>;
  /** Return the cached entries, building them on first use. */
  list(): Promise<CatalogEntry[]>;
  /** Look up a single entry by id (from the cached catalog). */
  get(id: string): Promise<CatalogEntry | undefined>;
};

/**
 * Normalise an entry: trim text and guarantee a non-empty description so every
 * entry is matchable (criterion 7.1). Entries with no usable name are dropped by
 * the caller; here we only sanitise fields.
 */
const normalise = (entry: CatalogEntry): CatalogEntry => ({
  ...entry,
  name: entry.name.trim(),
  description: entry.description.trim(),
  keywords: entry.keywords?.map((k) => k.trim()).filter((k) => k.length > 0),
});

/**
 * Create a tool/skill {@link ICatalog} from injected source loaders.
 *
 * De-duplicates by `id` (skills win over tools on collision, which is arbitrary
 * but stable) and drops entries lacking both a name and a description so the
 * catalog only contains matchable items.
 *
 * @param deps Source loaders + optional persistence. See {@link CatalogDeps}.
 * @returns A catalog that builds lazily and caches its entries.
 */
export const createCatalog = (deps: CatalogDeps): ICatalog => {
  let cache: CatalogEntry[] | undefined;

  const build = async (): Promise<CatalogEntry[]> => {
    const [skills, tools] = await Promise.all([deps.loadSkills(), deps.loadMcpTools()]);
    const byId = new Map<string, CatalogEntry>();
    // Tools first, then skills, so a skill with a colliding id overrides a tool.
    for (const entry of [...tools, ...skills]) {
      const clean = normalise(entry);
      if (clean.name.length === 0 && clean.description.length === 0) continue;
      byId.set(clean.id, clean);
    }
    const entries = [...byId.values()];
    if (deps.persist) await deps.persist(entries);
    return entries;
  };

  const refresh: ICatalog['refresh'] = async () => {
    cache = await build();
    return cache;
  };

  const list: ICatalog['list'] = async () => {
    if (!cache) cache = await build();
    return cache;
  };

  const get: ICatalog['get'] = async (id) => {
    const entries = await list();
    return entries.find((e) => e.id === id);
  };

  return { refresh, list, get };
};
