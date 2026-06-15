/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Realtime Knowledge (RTK) — shared type vocabulary.
 *
 * RTK is a memory layer for time-sensitive WORLD facts (latest version numbers,
 * prices, current role holders, evolving API specs, statistics...) that go stale
 * over time. Each fact carries its current value plus the evidence and freshness
 * metadata needed to decide whether it can still be trusted: sources, the time
 * the value was valid (`validAsOf`), a TTL, and a derived freshness state.
 *
 * This module is PURE: it declares types and a few small constant tables only —
 * no I/O, no Node/DOM APIs — so it can be imported from anywhere and unit-tested
 * trivially. The spec lives at `.aionui/specs/realtime-knowledge/`.
 *
 * Distinct from `exp-graph` (ExpBase), which remembers the agent's own
 * debugging/coding experience; RTK remembers facts about the outside world.
 */

/** How quickly a class of fact tends to change — drives the default TTL. */
export type VolatilityClass =
  | 'version' // software release / latest version
  | 'price' // price / cost / plan
  | 'role_holder' // who currently holds a role (CEO, maintainer...)
  | 'spec_api' // API surface / spec that evolves
  | 'status_event' // status of an ongoing event
  | 'stat_metric' // a statistic / metric that updates
  | 'other';

/** Derived staleness of a fact relative to "now". */
export type Freshness = 'fresh' | 'stale' | 'expired' | 'unknown';

/** Lifecycle status of a fact. */
export type FactStatus = 'active' | 'superseded' | 'needs_review' | 'archived';

/** A piece of evidence backing a fact's value. */
export type FactSource = {
  /** Canonical URL of the source. */
  url: string;
  /** Optional human-readable title. */
  title?: string;
  /** ISO timestamp when this source was fetched. */
  fetchedAt: string;
  /** Optional short snippet quoted from the source. */
  snippet?: string;
};

/** One historical value of a fact, kept when the value changes. */
export type FactHistoryEntry = {
  /** The previous value. */
  value: string;
  /** When that value was valid (from its sources). */
  validAsOf: string;
  /** The sources that backed that value. */
  sources: FactSource[];
  /** When the value was replaced. */
  changedAt: string;
  /** Why it changed (e.g. "scheduled refresh", "in-chat verification"). */
  reason: string;
};

/**
 * A single time-sensitive fact tracked by RTK.
 *
 * `topic` is the stable, normalised key (e.g. `nodejs.lts.version`); `question`
 * and `aliases` capture the natural-language ways a user might ask for it and
 * feed the embedding text for semantic retrieval.
 */
export type KnowledgeFact = {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Stable normalised key, e.g. `nodejs.lts.version`. */
  topic: string;
  /** The canonical natural-language question this fact answers. */
  question: string;
  /** Alternative phrasings of the question (improve recall). */
  aliases: string[];
  /** The current value. */
  value: string;
  volatilityClass: VolatilityClass;
  /** Time-to-live in milliseconds before the value is considered expired. */
  ttlMs: number;
  /** ISO timestamp the value was valid as of (from its sources). */
  validAsOf: string;
  /** ISO timestamp the value expires (derived: validAsOf + ttlMs). */
  expiresAt: string;
  sources: FactSource[];
  /** Confidence in the current value, 0..1. */
  confidence: number;
  /** Derived freshness; recomputed on read. */
  freshness: Freshness;
  /** Newest-last history of previous values. */
  history: FactHistoryEntry[];
  tags: string[];
  /** Text used to build the semantic embedding. */
  embeddingText: string;
  status: FactStatus;
  /** When `status === 'superseded'`, the id of the fact that replaced it. */
  supersededBy?: string;
};

/** A typed relation between two facts (graph layer). */
export type KnowledgeRelation = {
  fromId: string;
  toId: string;
  kind: 'supersedes' | 'contradicts' | 'depends_on' | 'same_topic_as' | 'derived_from';
};

/**
 * The minimal data needed to create or update a fact. The store/service fills
 * in derived fields (`id`, timestamps, `expiresAt`, `freshness`, `embeddingText`).
 */
export type FactDraft = {
  topic: string;
  question: string;
  aliases?: string[];
  value: string;
  volatilityClass: VolatilityClass;
  /** Override the default TTL for the volatility class. */
  ttlMs?: number;
  /** When the value was valid (defaults to now). */
  validAsOf?: string;
  sources?: FactSource[];
  confidence?: number;
  tags?: string[];
};

/** Default TTL (ms) per volatility class. Tuned so volatile facts refresh often. */
export const DEFAULT_TTL_BY_CLASS: Readonly<Record<VolatilityClass, number>> = {
  version: 7 * 24 * 60 * 60 * 1000, // 1 week
  price: 24 * 60 * 60 * 1000, // 1 day
  role_holder: 30 * 24 * 60 * 60 * 1000, // 30 days
  spec_api: 14 * 24 * 60 * 60 * 1000, // 2 weeks
  status_event: 6 * 60 * 60 * 1000, // 6 hours
  stat_metric: 3 * 24 * 60 * 60 * 1000, // 3 days
  other: 14 * 24 * 60 * 60 * 1000, // 2 weeks
};

/**
 * Fraction of the TTL after which a fact is flagged `stale` (still usable, but
 * the scheduler/in-chat detector may refresh it). Expired = past `expiresAt`.
 */
export const STALE_THRESHOLD_RATIO = 0.75;
