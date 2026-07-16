/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the Exp Graph / ExpBase experience-memory engine.
 *
 * The engine records debugging/coding experiences (successful fixes, mistakes,
 * failed attempts, lessons) as normalized {@link ExperienceEntry} records, then
 * retrieves the closest lessons when the agent meets a similar problem again.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs. Types are pure
 * data and safe to import from tests.
 */

/** What kind of experience an entry captures. */
export type ExperienceKind = 'successful_fix' | 'agent_mistake' | 'failed_attempt' | 'lesson';

/** Lifecycle status of an entry; superseded/archived rank lower or are filtered. */
export type ExperienceStatus = 'active' | 'superseded' | 'archived';

/** Result of a single verification command attached to an entry. */
export type VerificationOutcome = 'passed' | 'failed' | 'not_run';

/** All valid {@link ExperienceKind} values, for runtime validation. */
export const EXPERIENCE_KINDS: readonly ExperienceKind[] = [
  'successful_fix',
  'agent_mistake',
  'failed_attempt',
  'lesson',
];

/** All valid {@link ExperienceStatus} values, for runtime validation. */
export const EXPERIENCE_STATUSES: readonly ExperienceStatus[] = ['active', 'superseded', 'archived'];

/** All valid {@link VerificationOutcome} values, for runtime validation. */
export const VERIFICATION_OUTCOMES: readonly VerificationOutcome[] = ['passed', 'failed', 'not_run'];

/** Typed relations between experience entries (Phase 3 — Exp Graph). */
export type ExperienceRelationType =
  | 'same_symptom_as'
  | 'same_root_cause'
  | 'supersedes'
  | 'contradicts'
  | 'applies_to';

/** All valid {@link ExperienceRelationType} values, for runtime validation. */
export const EXPERIENCE_RELATION_TYPES: readonly ExperienceRelationType[] = [
  'same_symptom_as',
  'same_root_cause',
  'supersedes',
  'contradicts',
  'applies_to',
];

/** A directed relation from one entry to another. */
export type ExperienceRelation = {
  type: ExperienceRelationType;
  targetId: string;
};

/** A single verification command and its outcome. */
export type ExperienceVerificationCommand = {
  command: string;
  outcome: VerificationOutcome;
  notes?: string;
};

/** Verification evidence supporting an entry's trustworthiness. */
export type ExperienceVerification = {
  commands: ExperienceVerificationCommand[];
  confidenceEvidence: string[];
};

/** The observed error / symptom description. */
export type ExperienceSymptoms = {
  summary: string;
  errorMessages: string[];
  stackTraceDigest?: string;
};

/** Technical context that scopes where an experience applies. */
export type ExperienceContext = {
  workspace?: string;
  repoArea: string[];
  files: string[];
  commands: string[];
  runtime?: string;
  frameworks: string[];
  packages: string[];
  /** Coarse error class, e.g. `TypeError`, `compile`, `test-failure`. */
  errorCategory?: string;
};

/** The applied fix (present for `successful_fix`, optional otherwise). */
export type ExperienceFix = {
  summary: string;
  steps: string[];
  changedFiles: string[];
};

/** Where a compact lesson may be reused: one repository or every workspace. */
export type ExperienceScope = 'repo' | 'app';

/** A fully normalized experience record persisted in the store. */
export type ExperienceEntry = {
  id: string;
  createdAt: string;
  updatedAt: string;
  projectId: string;
  /** `repo` lessons are projected into `.mtui/exp`; `app` lessons are global. */
  scope?: ExperienceScope;
  sourceSessionId?: string;
  kind: ExperienceKind;
  symptoms: ExperienceSymptoms;
  context: ExperienceContext;
  rootCause?: string;
  fix?: ExperienceFix;
  lesson: string;
  verification: ExperienceVerification;
  tags: string[];
  /** Trust level in `[0, 1]`. */
  confidence: number;
  relatedEntryIds: string[];
  /** Typed graph relations to other entries (Phase 3). */
  relations: ExperienceRelation[];
  supersededBy?: string;
  /** Deterministic text used to compute the embedding vector. */
  embeddingText: string;
  status: ExperienceStatus;
  /** Normalized embedding vector; absent when no embedder was available. */
  vector?: number[];
};

/**
 * The raw input used to create an entry. `id`, timestamps, `embeddingText`,
 * `status`, and `vector` are derived by the capture service.
 */
export type ExperienceEntryDraft = {
  projectId?: string;
  scope?: ExperienceScope;
  sourceSessionId?: string;
  kind: ExperienceKind;
  symptoms: Partial<ExperienceSymptoms> & { summary: string };
  context?: Partial<ExperienceContext>;
  rootCause?: string;
  fix?: Partial<ExperienceFix> & { summary: string };
  lesson?: string;
  verification?: Partial<ExperienceVerification>;
  tags?: string[];
  confidence?: number;
  relatedEntryIds?: string[];
};

/** A patch applied to an existing entry via the store. */
export type ExperienceEntryPatch = Partial<Omit<ExperienceEntry, 'id' | 'createdAt'>>;

/** Filter for metadata-only lookups in the store. */
export type ExperienceFilter = {
  projectId?: string;
  scope?: ExperienceScope;
  kind?: ExperienceKind;
  status?: ExperienceStatus;
  tags?: string[];
};

/** A problem description used to query the ExpBase. */
export type ExperienceQuery = {
  symptom: string;
  errorMessages?: string[];
  stackTraceDigest?: string;
  files?: string[];
  commands?: string[];
  frameworks?: string[];
  packages?: string[];
  errorCategory?: string;
  projectId?: string;
};

/** A concise, advisory suggestion returned to the agent. */
export type ExperienceSuggestion = {
  entryId: string;
  score: number;
  kind: ExperienceKind;
  symptom: string;
  lesson: string;
  whyRelevant: string[];
  caution: string[];
  suggestedChecks: string[];
  /** Graph-enriched related lessons (Phase 3); empty unless enrichment ran. */
  related?: ExperienceRelatedLesson[];
};

/** A related lesson surfaced via graph traversal from a primary suggestion. */
export type ExperienceRelatedLesson = {
  entryId: string;
  relation: ExperienceRelationType;
  kind: ExperienceKind;
  lesson: string;
};

/** Aggregate ExpBase usage metrics (Phase 4 — observability). */
export type ExperienceMetrics = {
  /** Number of retrieval calls that returned at least one suggestion. */
  retrievalsWithHits: number;
  /** Total retrieval calls. */
  retrievals: number;
  /** Suggestions surfaced to the agent. */
  suggestionsShown: number;
  /** Suggestions the agent reported as helpful. */
  accepted: number;
  /** Suggestions the agent reported as a false/unhelpful match. */
  falseMatches: number;
  /** Experiences captured (created or merged). */
  captures: number;
  updatedAt: string;
};

/** Current schema version of the MTUI projection file. */
export const EXPERIENCE_PROJECTION_VERSION = 1;

/**
 * Compact, flattened representation of one entry written to the MTUI projection
 * file (`.mtui/exp/index.json`). MTUI ranks these without calling a model.
 */
export type ExperienceProjectionEntry = {
  id: string;
  scope: ExperienceScope;
  kind: ExperienceKind;
  status: ExperienceStatus;
  symptom: string;
  lesson: string;
  tags: string[];
  frameworks: string[];
  packages: string[];
  files: string[];
  commands: string[];
  errorCategory?: string;
  confidence: number;
  /** Derived `[0, 1]` strength of the entry's verification evidence. */
  verificationStrength: number;
  updatedAt: string;
  /** Lower-cased token soup for MTUI's lexical fallback ranking. */
  lexicalText: string;
  caution: string[];
  suggestedChecks: string[];
  /** Typed graph relations (Phase 3); included so retrieval can traverse. */
  relations: ExperienceRelation[];
  /** Normalized embedding vector; absent when no embedder was available. */
  vector?: number[];
};

/** The full MTUI projection document read by `mtui exp`. */
export type ExperienceProjection = {
  version: number;
  providerId?: string;
  model?: string;
  dimensions: number;
  builtAt: number;
  entries: ExperienceProjectionEntry[];
};

/** A draft queued by `mtui exp add` into `.mtui/exp/inbox.jsonl`. */
export type ExperienceInboxItem = {
  receivedAt: string;
  draft: ExperienceEntryDraft;
};

/** A feedback signal queued by `mtui exp feedback` into `.mtui/exp/feedback.jsonl`. */
export type ExperienceFeedbackItem = {
  id: string;
  helped: boolean;
  at?: string;
};

/** Outcome of a capture call (created a new entry or merged into an existing one). */
export type CaptureResult = {
  entry: ExperienceEntry;
  action: 'created' | 'updated';
};

// ---------------------------------------------------------------------------
// IPC contract (renderer-safe: types + channel names only, no Node/Electron).
// ---------------------------------------------------------------------------

/** IPC channel names for the ExpBase bridge. */
export const EXPERIENCE_CHANNELS = {
  record: 'experience.record',
  search: 'experience.search',
  drain: 'experience.drain',
  forget: 'experience.forget',
  feedback: 'experience.feedback',
  metrics: 'experience.metrics',
  list: 'experience.list',
  verifyOutcome: 'experience.verify-outcome',
} as const;

/** Standard bridge result envelope. */
export type ExperienceResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type ExperienceRecordRequest = { projectRoot: string; draft: ExperienceEntryDraft };
export type ExperienceSearchRequest = { projectRoot: string; query: ExperienceQuery; topK?: number; minScore?: number };
export type ExperienceDrainRequest = { projectRoot: string };
export type ExperienceForgetRequest = { projectRoot: string; entryId: string };
export type ExperienceFeedbackRequest = { projectRoot: string; entryId: string; helped: boolean };
export type ExperienceMetricsRequest = { projectRoot: string };
export type ExperienceListRequest = { projectRoot: string; filter?: ExperienceFilter };
