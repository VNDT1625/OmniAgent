/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session "super-memory" for IDE agents — a high-capacity, EPHEMERAL working
 * memory scoped to a single IDE chat session (one chat tab / one conversation).
 *
 * ## What problem this solves
 *
 * MTUI already holds a large amount of repo context (the map / compass / read
 * layer). So an IDE agent does NOT need to re-derive everything every turn. What
 * it lacks is a place to REMEMBER the few things it must keep across turns WITHIN
 * one session: a decision it made, a fact it had to dig for that MTUI does not
 * surface, a short-lived secret (an API key the user pasted for this session
 * only), a running TODO list. This store is that scratchpad.
 *
 * ## Lifecycle — exists only while the tab is open
 *
 * The memory is held **in RAM only** (no disk, no `userData`, never synced). A
 * session is created lazily on first write and lives until {@link clearSession}
 * (the renderer calls it when the chat tab closes) — or until the app restarts.
 * "Open the tab → the memory exists; close the tab → the memory is gone." This is
 * deliberately the opposite of the persistent company-agent memory
 * (`company/memoryStore.ts`), which lives on disk forever.
 *
 * ## Production-grade memory characteristics (less token, faster, wider recall)
 *
 * The store is tuned for the three things that matter in practice — token cost,
 * latency, and effective recall capacity — WITHOUT a vector DB, a model call, or
 * a network hop (so it stays fast and works offline):
 *
 * 1. **De-duplication + update on write** — a new note that is (near-)identical
 *    to an existing one UPDATES that note (refreshes recency, bumps its access
 *    count, keeps the richer text) instead of appending a duplicate. This is the
 *    mem0-style "consolidate" step done deterministically, so the store never
 *    bloats with restated facts → fewer tokens, wider effective capacity.
 * 2. **Salience-based eviction** — when the token budget is crossed, compaction
 *    folds the LEAST salient notes first (oldest AND least-accessed), keeping the
 *    notes the agent actually keeps using. Pinned notes are never folded.
 * 3. **Token-bounded, relevance-ranked recall** — {@link recall} returns at most
 *    `recallTokenBudget` tokens, prioritising pinned + summaries + the notes most
 *    relevant to the query (a cheap lexical overlap score) or most salient. So a
 *    single recall stays small and on-topic (mem0 keeps retrieval ~7k tokens; we
 *    aim far lower) → less context to read, faster turns.
 * 4. **Accurate-ish token accounting** — the default estimator counts words +
 *    CJK characters rather than naive chars/4, so compaction triggers at the
 *    right time for both prose and code.
 * 5. **Forced, local summarisation** — over budget, the oldest foldable notes are
 *    condensed into ONE summary note via the injected summariser. The default is
 *    a fast heuristic (no model, no latency, zero extra tokens); a model-backed
 *    summariser can be injected when richer summaries are worth the latency.
 *
 * ## Testability
 *
 * The factory {@link createSessionMemoryStore} is pure: the summariser, the
 * clock, the token estimator, and the dedup threshold are all injected, so the
 * dedup / eviction / compaction policy is fully deterministic in unit tests
 * (no model, no real time, no disk). The Main-process singleton
 * ({@link getSessionMemoryStore}) wires the default heuristic summariser.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs. It only manages
 * in-memory maps, so it is equally safe to unit-test under plain Node.
 */

import type { SuperMemoryEmbedder } from './embedding';
import { cosineSimilarity, createLocalEmbedder } from './embedding';

/** Category of a remembered note (purely advisory — helps the agent + UI scan). */
export type SuperMemoryKind = 'fact' | 'decision' | 'todo' | 'snippet' | 'note' | 'summary';

/** Kinds an agent is allowed to record (the `summary` kind is reserved for compaction). */
export const RECORDABLE_KINDS: ReadonlyArray<Exclude<SuperMemoryKind, 'summary'>> = ['fact', 'decision', 'todo', 'snippet', 'note'];

/** One remembered note inside a session. */
export type SuperMemoryItem = {
  /** Stable per-session id (e.g. `m1`, `m2`; summaries use `s1`, `s2`). */
  id: string;
  /** The remembered text. */
  text: string;
  /** Category (advisory). */
  kind: SuperMemoryKind;
  /** Pinned notes are never summarised away (use sparingly for critical facts). */
  pinned: boolean;
  /** Creation / last-refresh time (Unix ms). Updated when a duplicate refreshes it. */
  createdAt: number;
  /** Estimated token cost of `text` (cached so the budget check is cheap). */
  tokens: number;
  /** How many times this note has been surfaced by {@link recall} (salience signal). */
  accessCount: number;
  /** When this note was last surfaced by {@link recall} (Unix ms), or its createdAt. */
  lastAccessedAt: number;
};

/** What an agent passes to {@link ISessionMemoryStore.remember}. */
export type RememberInput = {
  /** The text to remember (required, non-empty after trimming). */
  text: string;
  /** Category. Defaults to `'note'`. The `summary` kind is rejected. */
  kind?: Exclude<SuperMemoryKind, 'summary'>;
  /** Pin this note so compaction never folds it away. Defaults to `false`. */
  pinned?: boolean;
};

/** A point-in-time view of a session, for the UI status surface / diagnostics. */
export type SuperMemorySnapshot = {
  sessionId: string;
  /** All notes (summaries + pinned + recent), oldest first. */
  items: SuperMemoryItem[];
  /** Names of the secret keys held this session (values are NEVER exposed here). */
  secretKeys: string[];
  /** Total estimated tokens currently held by `items`. */
  tokensUsed: number;
  /** The configured token budget that triggers compaction. */
  tokenBudget: number;
  /** Number of compaction passes performed this session. */
  compactions: number;
  /** Number of duplicate writes merged into existing notes (dedup savings). */
  deduped: number;
  /** Number of {@link recall} calls served this session (observability). */
  recalls: number;
  /** When the last compaction ran (Unix ms), or null if never. */
  lastCompactedAt: number | null;
};

/** The recall payload returned to an agent: a compact, ready-to-read context block. */
export type SuperMemoryRecall = {
  /** The compacted summaries (folded older notes), oldest first. */
  summaries: SuperMemoryItem[];
  /** Pinned notes, always returned in full. */
  pinned: SuperMemoryItem[];
  /** The most relevant recent / matching notes, within the recall token budget. */
  recent: SuperMemoryItem[];
  /** Secret KEY names available this session (values fetched via getSecret only). */
  secretKeys: string[];
  /** Estimated tokens of the returned block (so callers can verify it stays lean). */
  tokens: number;
};

/**
 * Summarises a batch of older notes into one short text block. Injected so the
 * store never hardcodes a model — production wires a heuristic (or model) one,
 * tests wire a deterministic stub.
 */
export type SuperMemorySummarizer = (items: SuperMemoryItem[]) => Promise<string>;

/** Thresholds + trim policy. All fields default via {@link DEFAULT_SUPER_MEMORY_POLICY}. */
export type SuperMemoryPolicy = {
  /** Compact when a session's notes exceed this many estimated tokens. */
  tokenBudget: number;
  /** Number of most-SALIENT non-pinned notes always kept verbatim (never folded). */
  keepRecent: number;
  /** Max pinned notes; beyond this the OLDEST pinned auto-unpins (avoids budget lock). */
  maxPinned: number;
  /** Max notes returned in {@link SuperMemoryRecall.recent}. */
  recallRecent: number;
  /** Max estimated tokens a single {@link recall} may return (keeps retrieval lean). */
  recallTokenBudget: number;
  /** Jaccard similarity (0..1) at/above which a new note is treated as a duplicate. */
  dedupThreshold: number;
  /** Max estimated tokens a single note may hold (oversized notes are truncated). */
  maxNoteTokens: number;
  /** Hard cap on notes per session (defensive against runaway writers). */
  maxItems: number;
  /** Max secrets per session (defensive). */
  maxSecrets: number;
  /** Max characters a single secret value may hold (defensive). */
  maxSecretValueLength: number;
};

/** Conservative defaults — large enough to be useful, small enough to stay lean. */
export const DEFAULT_SUPER_MEMORY_POLICY: SuperMemoryPolicy = {
  tokenBudget: 6000,
  keepRecent: 12,
  maxPinned: 32,
  recallRecent: 20,
  recallTokenBudget: 1500,
  dedupThreshold: 0.82,
  maxNoteTokens: 1000,
  maxItems: 500,
  maxSecrets: 64,
  maxSecretValueLength: 8192,
};

/** Injected collaborators + tunables for {@link createSessionMemoryStore}. */
export type SessionMemoryStoreOptions = {
  /** Folds older notes into a short summary during forced compaction. */
  summarizer: SuperMemorySummarizer;
  /** Threshold/trim overrides merged over {@link DEFAULT_SUPER_MEMORY_POLICY}. */
  policy?: Partial<SuperMemoryPolicy>;
  /** Wall-clock source (Unix ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Token estimator for a string. Defaults to a word + CJK-char heuristic. */
  estimateTokens?: (text: string) => number;
  /**
   * Optional embedder for SEMANTIC recall. When provided, a query is ranked by
   * vector cosine similarity (sub-word aware) instead of plain token overlap, so
   * "authentication" recalls a note about "auth", etc. Omit to keep the cheaper
   * lexical recall. The Main-process singleton wires the local embedder.
   */
  embedder?: SuperMemoryEmbedder;
};

/** Outcome flag from a {@link ISessionMemoryStore.remember} call. */
export type RememberResult = {
  /** The note that was stored (or the existing note that was refreshed). */
  item: SuperMemoryItem;
  /** Whether the write was merged into an existing near-duplicate note. */
  deduped: boolean;
  /** Whether the note text was truncated to the per-note token cap. */
  truncated: boolean;
  /** Whether storing it triggered a forced compaction pass. */
  compacted: boolean;
  /** Tokens held by the session after the write (and any compaction). */
  tokensUsed: number;
  /** The configured budget (so the agent can see how close it is). */
  tokenBudget: number;
};

/** Public contract of the session super-memory store. */
export type ISessionMemoryStore = {
  /** Record a note; de-dups against near-identical notes and auto-compacts at budget. */
  remember(sessionId: string, input: RememberInput): Promise<RememberResult>;
  /** Read back a compact, token-bounded context block (summaries + pinned + relevant). */
  recall(sessionId: string, opts?: { query?: string; limit?: number }): SuperMemoryRecall;
  /** Forget a single note by id. Returns whether it existed. */
  forget(sessionId: string, id: string): boolean;
  /** Store a session-only secret (e.g. an API key) — RAM only, gone on clear. */
  setSecret(sessionId: string, key: string, value: string): void;
  /** Read a session-only secret value, or undefined. */
  getSecret(sessionId: string, key: string): string | undefined;
  /** List the secret KEY names held this session (never the values). */
  listSecretKeys(sessionId: string): string[];
  /** Delete one secret. Returns whether it existed. */
  deleteSecret(sessionId: string, key: string): boolean;
  /** A point-in-time view of a session (empty session if unknown). */
  snapshot(sessionId: string): SuperMemorySnapshot;
  /** Drop EVERYTHING for a session — called when the chat tab closes. */
  clearSession(sessionId: string): void;
  /** List the live session ids (diagnostics). */
  listSessions(): string[];
};

/** Internal per-session state. */
type SessionState = {
  items: SuperMemoryItem[];
  secrets: Map<string, string>;
  /** Per-note embedding vectors (only populated when an embedder is configured). */
  embeddings: Map<string, number[]>;
  counter: number;
  compactions: number;
  deduped: number;
  recalls: number;
  lastCompactedAt: number | null;
  /** Tail of the per-session write queue — serialises `remember` to avoid races. */
  tail: Promise<unknown>;
};

/** Minimum cosine similarity for a note to count as a semantic match for a query. */
const EMB_MIN_SIM = 0.12;
/** Hybrid recall weights: semantic cosine + normalised lexical overlap + exact-phrase bonus. */
const SCORE_SEMANTIC_WEIGHT = 1;
const SCORE_LEXICAL_WEIGHT = 1;
const SCORE_PHRASE_BONUS = 0.5;

/** Weight (in "virtual tokens") each prior access adds to a note's salience. */
const ACCESS_SALIENCE_WEIGHT = 200;

/** Containment coefficient at/above which a superset note is treated as a duplicate. */
const DEDUP_CONTAINMENT_THRESHOLD = 0.9;
/** Minimum size of the smaller token set before containment-based dedup may apply. */
const DEDUP_MIN_CONTAINMENT_SIZE = 3;

/**
 * Default token estimator. Counts word-ish runs + each CJK character (which are
 * ~1 token each), which tracks real tokenisers far better than naive chars/4 for
 * mixed prose / code / CJK. Still pure + cheap.
 */
const defaultEstimateTokens = (text: string): number => {
  if (!text) return 1;
  const cjk = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) ?? []).length;
  const words = (text.replace(/[\u3000-\u9fff\uac00-\ud7af]/g, ' ').match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) ?? []).length;
  // ~0.75 word per token is a common ratio; bias slightly up for safety.
  return Math.max(1, Math.ceil(words / 0.75) + cjk);
};

/** Normalise text to a comparable token set for de-duplication. */
const tokenSet = (text: string): Set<string> => {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return new Set(tokens);
};

/** Jaccard similarity of two token sets (0..1). */
const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
};

/**
 * Duplicate-similarity score of two token sets. Uses Jaccard, but also treats a
 * SUPERSET as a duplicate (a richer restatement of the same fact): when the
 * smaller set is fully-ish contained in the larger one (containment coefficient
 * high enough and the smaller set non-trivial), it scores as a duplicate so the
 * store keeps the richer note instead of accumulating both. This catches "cache
 * uses redis" → "cache uses redis with a 60s TTL" which plain Jaccard misses.
 */
const dedupScore = (a: Set<string>, b: Set<string>): number => {
  const j = jaccard(a, b);
  if (a.size === 0 || b.size === 0) return j;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const minSize = Math.min(a.size, b.size);
  const containment = intersection / minSize;
  if (minSize >= DEDUP_MIN_CONTAINMENT_SIZE && containment >= DEDUP_CONTAINMENT_THRESHOLD) {
    return Math.max(j, containment);
  }
  return j;
};

/** Normalise a session id (shared, no closure). */
const requireSessionId = (sessionId: string): string => {
  const trimmed = sessionId?.trim();
  if (!trimmed) throw new Error('A sessionId is required for IDE session memory.');
  return trimmed;
};

/** Sum of estimated tokens across a session's notes. */
const tokensOf = (state: SessionState): number => state.items.reduce((sum, item) => sum + item.tokens, 0);

/**
 * Salience of a note: higher = more valuable to keep. Driven by how often the
 * agent has recalled it plus its recency. Pinned notes are handled separately
 * (never folded), so this only ranks foldable notes.
 */
const salience = (item: SuperMemoryItem): number => item.accessCount * ACCESS_SALIENCE_WEIGHT + item.createdAt / 1e6;

/**
 * Run `fn` exclusively for a session: chain it after any in-flight write so two
 * concurrent `remember` calls on the same session never interleave their
 * `await`s and corrupt `state.items` (a real race because compaction awaits the
 * summariser between read and rewrite). The tail never rejects the chain, so one
 * failed write cannot wedge later ones.
 */
const runExclusive = <T>(state: SessionState, fn: () => Promise<T>): Promise<T> => {
  const result = state.tail.then(() => fn());
  state.tail = result.then(
    (): void => undefined,
    (): void => undefined
  );
  return result;
};

/**
 * Create a pure {@link ISessionMemoryStore}. All side effects (clock, token
 * estimate, summarisation, dedup threshold) are injected so dedup / eviction /
 * compaction are fully deterministic in tests.
 *
 * @param options Injected summariser + optional policy / clock / estimator.
 * @returns A ready-to-use session memory store.
 */
export const createSessionMemoryStore = (options: SessionMemoryStoreOptions): ISessionMemoryStore => {
  const { summarizer } = options;
  const policy: SuperMemoryPolicy = { ...DEFAULT_SUPER_MEMORY_POLICY, ...options.policy };
  const now = options.now ?? (() => Date.now());
  const estimateTokens = options.estimateTokens ?? defaultEstimateTokens;
  const embedder = options.embedder;

  /** Live sessions. A session is created lazily on first write. */
  const sessions = new Map<string, SessionState>();

  /** Get (or lazily create) a session's state. */
  const ensure = (sessionId: string): SessionState => {
    const id = requireSessionId(sessionId);
    let state = sessions.get(id);
    if (!state) {
      state = { items: [], secrets: new Map(), embeddings: new Map(), counter: 0, compactions: 0, deduped: 0, recalls: 0, lastCompactedAt: null, tail: Promise.resolve() };
      sessions.set(id, state);
    }
    return state;
  };

  /** Store an item's embedding when an embedder is configured (no-op otherwise). */
  const indexEmbedding = (state: SessionState, id: string, text: string): void => {
    if (embedder) state.embeddings.set(id, embedder.embed(text));
  };

  /**
   * Keep pinned notes under the cap: when too many are pinned, auto-unpin the
   * OLDEST ones so they become foldable again. Without this, an agent that pins
   * everything could lock the budget (pinned notes are never folded).
   */
  const enforcePinnedCap = (state: SessionState): void => {
    const pinned = state.items.filter((item) => item.pinned);
    if (pinned.length <= policy.maxPinned) return;
    const toUnpin = pinned.toSorted((a, b) => a.createdAt - b.createdAt).slice(0, pinned.length - policy.maxPinned);
    for (const item of toUnpin) item.pinned = false;
  };

  /**
   * Fold a batch of items into ONE summary note via the injected summariser:
   * remove the batch, insert a single summary in its place, and keep the
   * embedding index + counters in sync. Used both for ordinary notes and, when
   * ordinary notes are exhausted, for old summaries (a "meta-summary") so a very
   * long session never accumulates unbounded summaries.
   */
  const foldBatch = async (state: SessionState, batch: SuperMemoryItem[]): Promise<void> => {
    const ordered = batch.toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const summaryText = (await summarizer(ordered)).trim();
    const stamp = now();
    const foldIds = new Set(batch.map((item) => item.id));
    const oldestFoldedAt = ordered[0].createdAt;
    const remaining = state.items.filter((item) => !foldIds.has(item.id));
    const summaryItem: SuperMemoryItem = {
      id: `s${++state.counter}`,
      text: summaryText.length > 0 ? summaryText : `(${ordered.length} older notes condensed)`,
      kind: 'summary',
      pinned: false,
      createdAt: oldestFoldedAt,
      tokens: estimateTokens(summaryText),
      accessCount: 0,
      lastAccessedAt: stamp,
    };
    remaining.push(summaryItem);
    remaining.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    state.items = remaining;
    for (const foldId of foldIds) state.embeddings.delete(foldId);
    indexEmbedding(state, summaryItem.id, summaryItem.text);
    state.compactions++;
    state.lastCompactedAt = stamp;
  };

  /**
   * Forced compaction. While over the token budget, fold the LEAST-salient
   * ordinary notes (beyond the `keepRecent` kept ones) into a summary. When no
   * ordinary notes remain to fold but summaries still blow the budget, fold the
   * OLDEST summaries into a meta-summary so compaction always makes progress
   * (only pinned notes are immovable). A loop guard prevents spinning.
   */
  const compact = async (state: SessionState): Promise<boolean> => {
    let didCompact = false;
    for (let guard = 0; guard < 64; guard++) {
      if (tokensOf(state) <= policy.tokenBudget) break;

      const foldable = state.items.filter((item) => !item.pinned && item.kind !== 'summary');
      const trimCount = foldable.length - policy.keepRecent;
      if (trimCount > 0) {
        // Fold the LEAST-salient ordinary notes (oldest + least-accessed) first.
        const batch = foldable.toSorted((a, b) => salience(a) - salience(b)).slice(0, trimCount);
        // eslint-disable-next-line no-await-in-loop
        await foldBatch(state, batch);
        didCompact = true;
        continue;
      }

      // No ordinary notes left to fold — collapse the oldest summaries instead.
      const summaries = state.items.filter((item) => item.kind === 'summary').toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      if (summaries.length >= 2) {
        const batch = summaries.slice(0, Math.max(2, Math.ceil(summaries.length / 2)));
        // eslint-disable-next-line no-await-in-loop
        await foldBatch(state, batch);
        didCompact = true;
        continue;
      }

      break; // only pinned + kept notes + a lone summary remain — cannot shrink further
    }
    return didCompact;
  };

  /**
   * Find an existing foldable note that is a near-duplicate of `text` (exact
   * normalised match, or Jaccard >= the dedup threshold). Returns it so the write
   * can refresh it instead of appending a duplicate.
   */
  const findDuplicate = (state: SessionState, text: string): SuperMemoryItem | undefined => {
    const incoming = tokenSet(text);
    let best: SuperMemoryItem | undefined;
    let bestScore = 0;
    for (const item of state.items) {
      if (item.kind === 'summary') continue;
      const score = dedupScore(incoming, tokenSet(item.text));
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return bestScore >= policy.dedupThreshold ? best : undefined;
  };

  const remember: ISessionMemoryStore['remember'] = async (sessionId, input) => {
    const state = ensure(sessionId);
    let text = input.text?.trim();
    if (!text) throw new Error('Cannot remember empty text.');
    if ((input.kind as string) === 'summary') throw new Error('The "summary" kind is reserved for compaction.');

    // Clamp an oversized note so a single write can never blow the whole budget
    // (the agent is told not to dump large file contents here).
    let truncated = false;
    if (estimateTokens(text) > policy.maxNoteTokens) {
      const ratio = policy.maxNoteTokens / estimateTokens(text);
      text = `${text.slice(0, Math.max(1, Math.floor(text.length * ratio)))}…[truncated]`;
      truncated = true;
    }
    const noteText = text;

    // Serialise the actual mutation so concurrent writes cannot corrupt state.
    return runExclusive(state, async (): Promise<RememberResult> => {
      // ── De-dup: refresh an existing near-identical note instead of appending. ──
      const duplicate = findDuplicate(state, noteText);
      if (duplicate) {
        if (noteText.length > duplicate.text.length) {
          duplicate.text = noteText;
          duplicate.tokens = estimateTokens(noteText);
          indexEmbedding(state, duplicate.id, duplicate.text);
        }
        if (input.kind) duplicate.kind = input.kind;
        duplicate.pinned = duplicate.pinned || input.pinned === true;
        duplicate.createdAt = now();
        duplicate.lastAccessedAt = duplicate.createdAt;
        duplicate.accessCount++;
        state.deduped++;
        if (duplicate.pinned) enforcePinnedCap(state);
        const compacted = await compact(state);
        return { item: { ...duplicate }, deduped: true, truncated, compacted, tokensUsed: tokensOf(state), tokenBudget: policy.tokenBudget };
      }

      const stamp = now();
      const item: SuperMemoryItem = {
        id: `m${++state.counter}`,
        text: noteText,
        kind: input.kind ?? 'note',
        pinned: input.pinned === true,
        createdAt: stamp,
        tokens: estimateTokens(noteText),
        accessCount: 0,
        lastAccessedAt: stamp,
      };
      state.items.push(item);
      indexEmbedding(state, item.id, item.text);
      if (item.pinned) enforcePinnedCap(state);

      // Defensive hard cap: drop the least-salient foldable note if over the cap.
      if (state.items.length > policy.maxItems) {
        const foldable = state.items.filter((it) => !it.pinned && it.kind !== 'summary');
        if (foldable.length > 0) {
          const victim = foldable.toSorted((a, b) => salience(a) - salience(b))[0];
          state.items = state.items.filter((it) => it.id !== victim.id);
          state.embeddings.delete(victim.id);
        }
      }

      const compacted = await compact(state);
      return { item: { ...item }, deduped: false, truncated, compacted, tokensUsed: tokensOf(state), tokenBudget: policy.tokenBudget };
    });
  };

  /**
   * Count how many query tokens appear in a note (lexical overlap). Pure helper
   * shared by the hybrid recall scorer.
   */
  const overlapCount = (queryTokens: Set<string>, item: SuperMemoryItem): number => {
    if (queryTokens.size === 0) return 0;
    const itemTokens = tokenSet(item.text);
    let overlap = 0;
    for (const token of queryTokens) if (itemTokens.has(token)) overlap++;
    return overlap;
  };

  const recall: ISessionMemoryStore['recall'] = (sessionId, opts) => {
    const id = requireSessionId(sessionId);
    const state = sessions.get(id);
    if (!state) return { summaries: [], pinned: [], recent: [], secretKeys: [], tokens: 0 };
    state.recalls++;

    const query = opts?.query?.trim().toLowerCase() ?? '';
    const queryTokens = query.length > 0 ? tokenSet(query) : new Set<string>();
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : policy.recallRecent;

    const summaries = state.items.filter((item) => item.kind === 'summary');
    const pinned = state.items.filter((item) => item.pinned);

    const ordinary = state.items.filter((item) => !item.pinned && item.kind !== 'summary');

    // HYBRID score: semantic cosine (when an embedder is wired) + normalised
    // lexical overlap + an exact-phrase bonus. Blending means an exact keyword
    // hit still surfaces even if its cosine is low, and a paraphrase still
    // surfaces even with zero token overlap — strictly better recall than either
    // signal alone. With no query, rank by salience.
    const useSemantic = query.length > 0 && embedder !== undefined;
    const qVec = useSemantic && embedder ? embedder.embed(query) : null;
    const scoreOf = (item: SuperMemoryItem): number => {
      if (query.length === 0) return salience(item);
      let score = 0;
      if (useSemantic && qVec && embedder) {
        const vec = state.embeddings.get(item.id) ?? embedder.embed(item.text);
        score += cosineSimilarity(qVec, vec) * SCORE_SEMANTIC_WEIGHT;
      }
      if (queryTokens.size > 0) score += (overlapCount(queryTokens, item) / queryTokens.size) * SCORE_LEXICAL_WEIGHT;
      if (item.text.toLowerCase().includes(query)) score += SCORE_PHRASE_BONUS;
      return score;
    };
    const scores = new Map<string, number>();
    for (const item of ordinary) scores.set(item.id, scoreOf(item));

    // Match floor: semantic mode filters hash-noise below EMB_MIN_SIM; lexical-only
    // mode keeps any positive overlap.
    const matchFloor = useSemantic ? EMB_MIN_SIM : 0;
    const matched = query.length === 0 ? ordinary : ordinary.filter((item) => (scores.get(item.id) ?? 0) > matchFloor);

    // Rank by score (relevance/salience) desc; recency breaks ties.
    const ranked = matched.toSorted((a, b) => {
      const diff = (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0);
      if (diff !== 0) return diff;
      return b.createdAt - a.createdAt || b.id.localeCompare(a.id);
    });

    // Token-bounded selection: fill up to recallTokenBudget (minus what pinned +
    // summaries already cost) and the recallRecent count cap.
    const baseTokens = [...summaries, ...pinned].reduce((sum, it) => sum + it.tokens, 0);
    let budget = Math.max(0, policy.recallTokenBudget - baseTokens);
    const recent: SuperMemoryItem[] = [];
    for (const item of ranked) {
      if (recent.length >= limit) break;
      if (item.tokens > budget && recent.length > 0) continue; // keep filling smaller notes
      recent.push(item);
      budget -= item.tokens;
      if (budget <= 0) break;
    }

    // Restore chronological order for readability + bump salience on what we surfaced.
    recent.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const stamp = now();
    for (const item of recent) {
      item.accessCount++;
      item.lastAccessedAt = stamp;
    }

    const tokens = [...summaries, ...pinned, ...recent].reduce((sum, it) => sum + it.tokens, 0);
    return { summaries, pinned, recent, secretKeys: Array.from(state.secrets.keys()), tokens };
  };

  const forget: ISessionMemoryStore['forget'] = (sessionId, id) => {
    const sid = requireSessionId(sessionId);
    const state = sessions.get(sid);
    if (!state) return false;
    const before = state.items.length;
    state.items = state.items.filter((item) => item.id !== id);
    state.embeddings.delete(id);
    return state.items.length < before;
  };

  const setSecret: ISessionMemoryStore['setSecret'] = (sessionId, key, value) => {
    const state = ensure(sessionId);
    const trimmedKey = key?.trim();
    if (!trimmedKey) throw new Error('A secret key is required.');
    if (typeof value === 'string' && value.length > policy.maxSecretValueLength) {
      throw new Error(`Secret value too long (max ${policy.maxSecretValueLength} chars).`);
    }
    if (!state.secrets.has(trimmedKey) && state.secrets.size >= policy.maxSecrets) {
      throw new Error(`Too many session secrets (max ${policy.maxSecrets}).`);
    }
    state.secrets.set(trimmedKey, value);
  };

  const getSecret: ISessionMemoryStore['getSecret'] = (sessionId, key) => {
    const sid = requireSessionId(sessionId);
    return sessions.get(sid)?.secrets.get(key?.trim() ?? '');
  };

  const listSecretKeys: ISessionMemoryStore['listSecretKeys'] = (sessionId) => {
    const sid = requireSessionId(sessionId);
    const state = sessions.get(sid);
    return state ? Array.from(state.secrets.keys()) : [];
  };

  const deleteSecret: ISessionMemoryStore['deleteSecret'] = (sessionId, key) => {
    const sid = requireSessionId(sessionId);
    const state = sessions.get(sid);
    return state ? state.secrets.delete(key?.trim() ?? '') : false;
  };

  const snapshot: ISessionMemoryStore['snapshot'] = (sessionId) => {
    const id = requireSessionId(sessionId);
    const state = sessions.get(id);
    if (!state) {
      return {
        sessionId: id,
        items: [],
        secretKeys: [],
        tokensUsed: 0,
        tokenBudget: policy.tokenBudget,
        compactions: 0,
        deduped: 0,
        recalls: 0,
        lastCompactedAt: null,
      };
    }
    return {
      sessionId: id,
      items: state.items.map((item) => ({ ...item })),
      secretKeys: Array.from(state.secrets.keys()),
      tokensUsed: tokensOf(state),
      tokenBudget: policy.tokenBudget,
      compactions: state.compactions,
      deduped: state.deduped,
      recalls: state.recalls,
      lastCompactedAt: state.lastCompactedAt,
    };
  };

  const clearSession: ISessionMemoryStore['clearSession'] = (sessionId) => {
    sessions.delete(requireSessionId(sessionId));
  };

  const listSessions: ISessionMemoryStore['listSessions'] = () => Array.from(sessions.keys());

  return {
    remember,
    recall,
    forget,
    setSecret,
    getSecret,
    listSecretKeys,
    deleteSecret,
    snapshot,
    clearSession,
    listSessions,
  };
};

/**
 * Default heuristic summariser used by the Main-process singleton. It needs NO
 * model and NO network, so the feature degrades gracefully offline and adds zero
 * latency: it groups folded notes by kind, keeps the first sentence of each, and
 * truncates to a bounded length. This still "shortens the context" (the explicit
 * requirement) without an extra model call.
 */
export const heuristicSummarizer = (maxChars = 800): SuperMemorySummarizer => async (items) => {
  const lines = items.map((item) => {
    const firstSentence = item.text.split(/(?<=[.!?])\s/)[0] ?? item.text;
    const condensed = firstSentence.length > 140 ? `${firstSentence.slice(0, 140)}…` : firstSentence;
    return `- [${item.kind}] ${condensed}`;
  });
  const header = `Summary of ${items.length} earlier note(s):`;
  const full = `${header}\n${lines.join('\n')}`;
  return full.length > maxChars ? `${full.slice(0, maxChars)}…` : full;
};

/** Module-level singleton so the MCP wiring and the IPC bridge share one store. */
let singleton: ISessionMemoryStore | undefined;

/**
 * The Main-process session-memory singleton. Lazily created with the default
 * heuristic summariser (no model required). Both the agent-facing MCP wiring
 * (`ideMcpWiring.ts`) and the renderer-facing IPC bridge (`ideMemoryBridge.ts`)
 * import THIS instance so the agent's writes and the UI's snapshot/clear all hit
 * the same memory.
 */
export const getSessionMemoryStore = (): ISessionMemoryStore => {
  if (!singleton) singleton = createSessionMemoryStore({ summarizer: heuristicSummarizer(), embedder: createLocalEmbedder() });
  return singleton;
};
