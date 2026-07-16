/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `toolSelector` — the select → try → re-select loop (Yêu cầu 7, criteria 7.2 &
 * 7.6). For a request it:
 *
 * 1. Filters the catalog (Tier 1 keyword, then optionally Tier 2 semantic) down
 *    to a small top-k — it NEVER loads the whole catalog into the agent context
 *    (criterion 7.2 / Property 10).
 * 2. Tries the top candidate, checks the result, and on failure drops it and
 *    re-selects from the remaining candidates, up to a round limit (criterion 7.6).
 * 3. On success, records the choice in the {@link ISelectionLog} for fast reuse
 *    of similar future requests (criterion 7.7); `recall` short-circuits when a
 *    prior successful choice exists.
 *
 * The "try" step is injected (`attempt`) so the selector is agnostic to how a
 * tool is actually invoked. Process boundary: Main-process (Node.js) module.
 */

import type { CatalogEntry, ScoredEntry } from './catalogTypes';
import type { ICatalog } from './catalog';
import { keywordFilter, type KeywordFilterOptions } from './keywordFilter';
import type { ISemanticFilter } from './semanticFilter';
import type { ISelectionLog } from './selectionLog';

/** Outcome of trying one candidate tool against a request. */
export type AttemptResult = {
  /** Whether the tool produced an acceptable result. */
  ok: boolean;
  /** Optional detail (error message or result note) for logging. */
  detail?: string;
};

/** Function that tries a chosen entry for a request and reports whether it worked. */
export type AttemptFn = (entry: CatalogEntry, request: string) => Promise<AttemptResult>;

/** Options for {@link createToolSelector}. */
export type ToolSelectorDeps = {
  /** The capability catalog (Tier 0 input). */
  catalog: ICatalog;
  /** Optional Tier 2 semantic filter; when present, used to re-rank the keyword top-k. */
  semanticFilter?: ISemanticFilter;
  /** Selection log for recall + recording (criterion 7.7). */
  selectionLog: ISelectionLog;
  /** Max candidates to consider after filtering (top-k). Defaults to 5. */
  topK?: number;
  /** Max try/re-select rounds before giving up. Defaults to 3 (criterion 7.6). */
  maxRounds?: number;
  /** Keyword filter tuning. */
  keywordOptions?: KeywordFilterOptions;
};

/** The result of a {@link IToolSelector.select} call. */
export type SelectionResult = {
  /** Whether a tool ultimately succeeded. */
  succeeded: boolean;
  /** The candidate set considered (filtered top-k, never the whole catalog). */
  candidates: ScoredEntry[];
  /** The entries actually tried, in order. */
  tried: CatalogEntry[];
  /** The entry that succeeded, if any. */
  chosen?: CatalogEntry;
  /** True when the result came from the selection-log recall fast path. */
  fromRecall: boolean;
};

/** Public contract of the tool selector. */
export type IToolSelector = {
  /** Filter the catalog for a request WITHOUT trying anything (criterion 7.2). */
  shortlist(request: string): Promise<ScoredEntry[]>;
  /** Run the full select → try → re-select loop for a request. */
  select(request: string, attempt: AttemptFn): Promise<SelectionResult>;
};

/**
 * Create a {@link IToolSelector}.
 *
 * @param deps Catalog, optional semantic filter, selection log + tuning.
 * @returns A selector implementing the select–try–reselect loop.
 */
export const createToolSelector = (deps: ToolSelectorDeps): IToolSelector => {
  const topK = deps.topK ?? 5;
  const maxRounds = deps.maxRounds ?? 3;

  const shortlist: IToolSelector['shortlist'] = async (request) => {
    const entries = await deps.catalog.list();
    // Tier 1: keyword filter (cheap, always runs). Pull a slightly wider band so
    // Tier 2 has something to re-rank.
    const keyworded = keywordFilter(request, entries, { ...deps.keywordOptions, limit: Math.max(topK * 2, topK) });

    // Tier 2: semantic re-rank of the keyword candidates, when available. If the
    // keyword pass found nothing (e.g. paraphrased request), fall back to ranking
    // the whole catalog semantically — still returning only the top-k (never the
    // full catalog) so criterion 7.2 holds.
    if (deps.semanticFilter) {
      const base = keyworded.length > 0 ? keyworded.map((s) => s.entry) : entries;
      await deps.semanticFilter.index(base);
      const ranked = await deps.semanticFilter.rank(request, topK);
      if (ranked.length > 0) return ranked.slice(0, topK);
    }

    return keyworded.slice(0, topK);
  };

  const select: IToolSelector['select'] = async (request, attempt) => {
    const candidates = await shortlist(request);

    // Fast path: reuse a prior successful choice for a matching request (7.7).
    const recalled = await deps.selectionLog.recall(request);
    if (recalled && recalled.chosen.length > 0) {
      const firstId = recalled.chosen[0];
      const entry = candidates.find((c) => c.entry.id === firstId)?.entry ?? (await deps.catalog.get(firstId));
      if (entry) {
        const result = await attempt(entry, request);
        if (result.ok) {
          return { succeeded: true, candidates, tried: [entry], chosen: entry, fromRecall: true };
        }
        // Recalled choice no longer works — fall through to a fresh selection.
      }
    }

    const tried: CatalogEntry[] = [];
    const rounds = Math.min(maxRounds, candidates.length);
    for (let i = 0; i < rounds; i++) {
      const entry = candidates[i].entry;
      tried.push(entry);
      const result = await attempt(entry, request);
      if (result.ok) {
        await deps.selectionLog.record(request, [entry.id], true);
        return { succeeded: true, candidates, tried, chosen: entry, fromRecall: false };
      }
    }

    // Nothing worked within the round limit — record the failure for visibility.
    await deps.selectionLog.record(
      request,
      tried.map((e) => e.id),
      false
    );
    return { succeeded: false, candidates, tried, fromRecall: false };
  };

  return { shortlist, select };
};
