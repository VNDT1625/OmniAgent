/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Realtime Knowledge service — the facade that ties the store, vector index,
 * verification guardrail and refresh pipeline into the four behaviours the
 * feature promises:
 *
 *  - (a) `lookup`        — semantic retrieval of facts with freshness + sources.
 *  - (b) `refreshExpired`— scheduled refresh of stale/expired facts.
 *  - (c) `refresh`       — verify-then-update a single fact (in-chat self-update).
 *        `record`        — create/update a fact with the verification guardrail.
 *
 * Every write goes through {@link IVerificationService} (FR7): a value is only
 * overwritten with sufficient independent sources, the old value is pushed to
 * `history`, and `validAsOf` comes from the evidence — never a model guess.
 *
 * All collaborators are injected so the service is decoupled and unit-testable.
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { randomUUID } from 'node:crypto';
import { computeExpiresAt, computeFreshness, needsRefresh, resolveTtlMs } from './freshness';
import { buildEmbeddingText } from './embeddingText';
import type { IRtkStore } from './rtkStore';
import type { IRtkVectorIndex } from './rtkVectorIndex';
import type { IRefreshPipeline, RefreshResult } from './refreshPipeline';
import type { IVerificationService } from './verificationService';
import type { FactDraft, Freshness, KnowledgeFact, KnowledgeRelation } from './rtkTypes';

/** One grounded suggestion returned to the agent/LLM. */
export type GroundedFact = {
  fact: KnowledgeFact;
  /** Semantic similarity score for the query, in [0, 1]. */
  score: number;
  /** Freshness recomputed at lookup time. */
  freshness: Freshness;
  /** Short bullet reasons this fact is relevant / how trustworthy it is. */
  whyRelevant: string[];
};

/** The grounding payload handed to a model for a query. */
export type GroundingPack = {
  facts: GroundedFact[];
  /** Optional notice (e.g. "1 fact is expired and may be out of date"). */
  notice?: string;
};

/** Options for {@link IRtkService.lookup}. */
export type LookupOptions = {
  /** Max facts to return. Default 5. */
  topK?: number;
  /** Abort signal for the embedding call. */
  signal?: AbortSignal;
};

/** Summary of a {@link IRtkService.refreshExpired} sweep. */
export type RefreshSweepResult = {
  /** How many facts had their value accepted/updated or re-confirmed. */
  refreshed: number;
  /** How many were flagged `needs_review` (contested change). */
  review: number;
  /** How many were attempted in total. */
  attempted: number;
};

/** Dependencies for {@link createRtkService}. */
export type RtkServiceDeps = {
  store: IRtkStore;
  index: IRtkVectorIndex;
  verifier: IVerificationService;
  /** Network refresh pipeline. Required for `refresh`/`refreshExpired`; `lookup`/`record` work without it. */
  pipeline?: IRefreshPipeline;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Id generator. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
  /** Persist the vector index after mutations (e.g. to disk). Optional. */
  persistIndex?: (data: ReturnType<IRtkVectorIndex['toData']>) => Promise<void>;
};

/** Public contract of the realtime-knowledge service. */
export type IRtkService = {
  lookup(query: string, options?: LookupOptions): Promise<GroundingPack>;
  record(draft: FactDraft): Promise<KnowledgeFact>;
  refresh(idOrTopic: string, signal?: AbortSignal): Promise<KnowledgeFact>;
  refreshExpired(options?: { now?: number; signal?: AbortSignal; limit?: number }): Promise<RefreshSweepResult>;
  /** Add a typed relation between two facts (graph layer). Idempotent per (from,to,kind). */
  relate(relation: KnowledgeRelation): Promise<void>;
  /** List stored facts (newest-updated first), with freshness recomputed at `now`. */
  list(): Promise<KnowledgeFact[]>;
};

/**
 * Create an {@link IRtkService}.
 *
 * @param deps Store + index + verifier (+ optional pipeline / clock / id / index persistence).
 */
export const createRtkService = (deps: RtkServiceDeps): IRtkService => {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? ((): string => randomUUID());

  /** Recompute and persist a fact's derived freshness; return the refreshed copy. */
  const withFreshness = (fact: KnowledgeFact, at: number): KnowledgeFact => ({
    ...fact,
    freshness: computeFreshness(fact, at),
  });

  const flushIndex = async (): Promise<void> => {
    if (deps.persistIndex) await deps.persistIndex(deps.index.toData());
  };

  /** Reindex a fact's embedding text. */
  const reindex = async (fact: KnowledgeFact, signal?: AbortSignal): Promise<void> => {
    await deps.index.upsert(fact.id, fact.embeddingText, signal);
    await flushIndex();
  };

  const lookup = async (query: string, options?: LookupOptions): Promise<GroundingPack> => {
    const at = now();
    const topK = options?.topK ?? 5;
    const hits = await deps.index.query(query, topK, options?.signal);
    const relations = await deps.store.relations();
    // Facts that are superseded by some OTHER fact should not be surfaced.
    const supersededIds = new Set(relations.filter((r) => r.kind === 'supersedes').map((r) => r.toId));
    // Facts that have a contradiction relation get a caution annotation.
    const contradictedIds = new Set(
      relations.filter((r) => r.kind === 'contradicts').flatMap((r) => [r.fromId, r.toId])
    );
    const facts: GroundedFact[] = [];
    let hasExpired = false;
    for (const hit of hits) {
      const stored = await deps.store.get(hit.factId);
      if (!stored || stored.status === 'archived') continue;
      if (supersededIds.has(stored.id) || stored.status === 'superseded') continue;
      const freshness = computeFreshness(stored, at);
      if (freshness === 'expired') hasExpired = true;
      const whyRelevant = [
        `Matches "${stored.question}" (similarity ${(hit.score * 100).toFixed(0)}%).`,
        `Value valid as of ${stored.validAsOf}; freshness: ${freshness}.`,
        stored.sources.length > 0 ? `${stored.sources.length} source(s).` : 'No sources recorded.',
        stored.status === 'needs_review' ? 'Flagged needs_review — treat with caution.' : '',
        contradictedIds.has(stored.id) ? 'Has a contradicting fact on record — verify before trusting.' : '',
      ].filter((line) => line.length > 0);
      facts.push({ fact: withFreshness(stored, at), score: hit.score, freshness, whyRelevant });
    }
    const notice = hasExpired
      ? 'One or more facts are expired and may be out of date; consider refreshing before relying on them.'
      : undefined;
    return notice ? { facts, notice } : { facts };
  };

  const relate = async (relation: KnowledgeRelation): Promise<void> => {
    const existing = await deps.store.relations();
    const duplicate = existing.some(
      (r) => r.fromId === relation.fromId && r.toId === relation.toId && r.kind === relation.kind
    );
    if (duplicate) return;
    await deps.store.setRelations([...existing, relation]);
    // A 'supersedes' relation archives the superseded fact so it stops surfacing.
    if (relation.kind === 'supersedes') {
      const superseded = await deps.store.get(relation.toId);
      if (superseded && superseded.status === 'active') {
        await deps.store.patch(relation.toId, { status: 'superseded', supersededBy: relation.fromId });
      }
    }
  };

  const record = async (draft: FactDraft): Promise<KnowledgeFact> => {
    const at = now();
    const iso = new Date(at).toISOString();
    const existing = await deps.store.byTopic(draft.topic);
    const ttlMs = resolveTtlMs(draft.volatilityClass, draft.ttlMs);
    const validAsOf = draft.validAsOf ?? iso;
    const sources = draft.sources ?? [];

    if (existing) {
      // Updating an existing fact — apply the verification guardrail.
      const decision = deps.verifier.verify({
        currentValue: existing.value,
        proposedValue: draft.value,
        sources,
      });
      const applied = applyDecision(existing, {
        proposedValue: draft.value,
        sources,
        decision,
        validAsOf,
        ttlMs,
        confidence: draft.confidence,
        reason: 'manual record',
        at,
        aliases: draft.aliases,
        tags: draft.tags,
      });
      const saved = await deps.store.upsert(applied);
      await reindex(saved);
      return saved;
    }

    // New fact — create directly (manual entry seeds the knowledge base).
    const embeddingText = buildEmbeddingText({
      topic: draft.topic,
      question: draft.question,
      value: draft.value,
      aliases: draft.aliases,
      tags: draft.tags,
      volatilityClass: draft.volatilityClass,
    });
    const fact: KnowledgeFact = {
      id: newId(),
      createdAt: iso,
      updatedAt: iso,
      topic: draft.topic,
      question: draft.question,
      aliases: draft.aliases ?? [],
      value: draft.value,
      volatilityClass: draft.volatilityClass,
      ttlMs,
      validAsOf,
      expiresAt: computeExpiresAt(validAsOf, ttlMs),
      sources,
      confidence: draft.confidence ?? (sources.length > 0 ? 0.6 : 0.4),
      freshness: 'fresh',
      history: [],
      tags: draft.tags ?? [],
      embeddingText,
      status: 'active',
    };
    fact.freshness = computeFreshness(fact, at);
    const saved = await deps.store.upsert(fact);
    await reindex(saved);
    return saved;
  };

  const resolveTarget = async (idOrTopic: string): Promise<KnowledgeFact | null> =>
    (await deps.store.get(idOrTopic)) ?? (await deps.store.byTopic(idOrTopic));

  const refresh = async (idOrTopic: string, signal?: AbortSignal): Promise<KnowledgeFact> => {
    if (!deps.pipeline) {
      throw new Error('[RTK] refresh requires a refresh pipeline (researcher) to be configured.');
    }
    const fact = await resolveTarget(idOrTopic);
    if (!fact) {
      throw new Error(`[RTK] Unknown fact ${JSON.stringify(idOrTopic)}.`);
    }
    const result = await deps.pipeline.refresh(
      { topic: fact.topic, question: fact.question, value: fact.value, aliases: fact.aliases },
      signal
    );
    const at = now();
    const applied = applyDecision(fact, {
      proposedValue: result.proposedValue,
      sources: result.sources,
      decision: result.decision,
      validAsOf: new Date(at).toISOString(),
      ttlMs: fact.ttlMs,
      reason: 'refresh',
      at,
    });
    const saved = await deps.store.upsert(applied);
    if (saved.embeddingText !== fact.embeddingText) await reindex(saved, signal);
    return saved;
  };

  const refreshExpired = async (options?: {
    now?: number;
    signal?: AbortSignal;
    limit?: number;
  }): Promise<RefreshSweepResult> => {
    const at = options?.now ?? now();
    const all = await deps.store.list({ status: 'active' });
    const due = all.filter((fact) => needsRefresh(fact, at)).slice(0, options?.limit ?? all.length);
    let refreshed = 0;
    let review = 0;
    for (const fact of due) {
      try {
        const saved = await refresh(fact.id, options?.signal);
        if (saved.status === 'needs_review') review += 1;
        else refreshed += 1;
      } catch {
        // A single source failure must not abort the sweep; leave the fact as-is.
      }
    }
    return { refreshed, review, attempted: due.length };
  };

  const list = async (): Promise<KnowledgeFact[]> => {
    const at = now();
    const all = await deps.store.list();
    return all
      .map((fact) => withFreshness(fact, at))
      .toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  };

  return { lookup, record, refresh, refreshExpired, relate, list };
};

/** Inputs to {@link applyDecision}. */
type ApplyInput = {
  proposedValue: string;
  sources: KnowledgeFact['sources'];
  decision: RefreshResult['decision'];
  validAsOf: string;
  ttlMs: number;
  confidence?: number;
  reason: string;
  at: number;
  aliases?: string[];
  tags?: string[];
};

/**
 * Apply a verification decision to a fact (PURE): on `accept` of a changed value
 * the old value is pushed to history and the value/sources/timestamps updated; a
 * re-confirmation refreshes the validity window; `review` flags `needs_review`
 * without losing the current value; `reject` leaves the value but may lower
 * confidence.
 */
export const applyDecision = (fact: KnowledgeFact, input: ApplyInput): KnowledgeFact => {
  const iso = new Date(input.at).toISOString();
  const base: KnowledgeFact = {
    ...fact,
    updatedAt: iso,
    aliases: input.aliases ?? fact.aliases,
    tags: input.tags ?? fact.tags,
  };

  if (input.decision.action === 'accept') {
    const history = input.decision.changed
      ? [
          ...fact.history,
          {
            value: fact.value,
            validAsOf: fact.validAsOf,
            sources: fact.sources,
            changedAt: iso,
            reason: input.reason,
          },
        ]
      : fact.history;
    const value = input.decision.changed ? input.proposedValue : fact.value;
    const next: KnowledgeFact = {
      ...base,
      value,
      validAsOf: input.validAsOf,
      ttlMs: input.ttlMs,
      expiresAt: computeExpiresAt(input.validAsOf, input.ttlMs),
      sources: input.sources.length > 0 ? input.sources : fact.sources,
      confidence: input.confidence ?? Math.max(fact.confidence, input.decision.confidence),
      history,
      status: 'active',
    };
    next.embeddingText = buildEmbeddingText({
      topic: next.topic,
      question: next.question,
      value: next.value,
      aliases: next.aliases,
      tags: next.tags,
      volatilityClass: next.volatilityClass,
    });
    next.freshness = computeFreshness(next, input.at);
    return next;
  }

  if (input.decision.action === 'review') {
    return {
      ...base,
      status: 'needs_review',
      confidence: Math.min(fact.confidence, input.decision.confidence),
      freshness: computeFreshness(base, input.at),
    };
  }

  // reject — keep the value; nudge confidence down slightly to reflect a failed confirm.
  return {
    ...base,
    confidence: Number(Math.max(0, fact.confidence - 0.05).toFixed(3)),
    freshness: computeFreshness(base, input.at),
  };
};
