/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Capture service: turn a raw {@link ExperienceEntryDraft} into a normalized,
 * sanitized, (optionally) embedded {@link ExperienceEntry}, de-duplicating
 * against existing entries before persisting.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { randomUUID } from 'node:crypto';
import {
  EXPERIENCE_KINDS,
  type CaptureResult,
  type ExperienceEntry,
  type ExperienceEntryDraft,
  type ExperienceVerificationCommand,
} from './experienceTypes';
import {
  buildEmbeddingText,
  clampConfidence,
  normalizeStringList,
  redactList,
  redactSecrets,
  tokenize,
} from './experienceText';
import type { IExperienceStore } from './experienceStore';
import { embedOne, type ExperienceEmbedder } from './experienceVectorIndex';

/** Lexical Jaccard similarity above which a draft is merged into an existing entry. */
export const DEDUPE_THRESHOLD = 0.82;

/** Dependencies for {@link createExperienceCapture}. */
export type ExperienceCaptureDeps = {
  store: IExperienceStore;
  /** Embedding provider; when absent, entries are stored without a vector. */
  embedder?: ExperienceEmbedder | null;
  /** Clock returning an ISO timestamp. Injectable for tests. */
  now?: () => string;
  /** Id generator. Injectable for tests. */
  generateId?: () => string;
};

const VALID_OUTCOMES = new Set(['passed', 'failed', 'not_run']);

const normalizeVerificationCommands = (
  commands: ExperienceVerificationCommand[] | undefined
): ExperienceVerificationCommand[] =>
  (commands ?? [])
    .filter((command) => typeof command?.command === 'string' && command.command.trim().length > 0)
    .map((command) => ({
      command: command.command.trim(),
      outcome: VALID_OUTCOMES.has(command.outcome) ? command.outcome : 'not_run',
      notes: command.notes ? redactSecrets(command.notes) : undefined,
    }));

/** Jaccard similarity of the token sets of two texts. */
export const lexicalJaccard = (a: string, b: string): number => {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

/**
 * Normalize and sanitize a draft into a complete entry (without a vector).
 * Throws on an invalid `kind` so bad input never reaches the store.
 */
export const normalizeDraft = (draft: ExperienceEntryDraft, id: string, nowIso: string): ExperienceEntry => {
  if (!EXPERIENCE_KINDS.includes(draft.kind)) {
    throw new Error(`[Experience] Invalid kind ${JSON.stringify(draft.kind)}.`);
  }
  if (typeof draft.projectId !== 'string' || draft.projectId.trim().length === 0) {
    throw new Error('[Experience] Draft is missing a projectId.');
  }
  if (typeof draft.symptoms?.summary !== 'string' || draft.symptoms.summary.trim().length === 0) {
    throw new Error('[Experience] Draft is missing a symptom summary.');
  }

  const symptoms = {
    summary: redactSecrets(draft.symptoms.summary).trim(),
    errorMessages: redactList(draft.symptoms.errorMessages),
    stackTraceDigest: draft.symptoms.stackTraceDigest
      ? redactSecrets(draft.symptoms.stackTraceDigest).trim()
      : undefined,
  };
  const context = {
    workspace: draft.context?.workspace?.trim() || undefined,
    repoArea: normalizeStringList(draft.context?.repoArea),
    files: normalizeStringList(draft.context?.files),
    commands: normalizeStringList(draft.context?.commands),
    runtime: draft.context?.runtime?.trim() || undefined,
    frameworks: normalizeStringList(draft.context?.frameworks),
    packages: normalizeStringList(draft.context?.packages),
    errorCategory: draft.context?.errorCategory?.trim() || undefined,
  };
  const fix = draft.fix
    ? {
        summary: redactSecrets(draft.fix.summary).trim(),
        steps: redactList(draft.fix.steps),
        changedFiles: normalizeStringList(draft.fix.changedFiles),
      }
    : undefined;
  const verification = {
    commands: normalizeVerificationCommands(draft.verification?.commands),
    confidenceEvidence: redactList(draft.verification?.confidenceEvidence),
  };
  const lesson = redactSecrets(draft.lesson ?? '').trim();
  const tags = normalizeStringList(draft.tags);

  const core = {
    kind: draft.kind,
    symptoms,
    context,
    rootCause: draft.rootCause ? redactSecrets(draft.rootCause).trim() : undefined,
    fix,
    lesson,
    verification,
    tags,
  };

  return {
    id,
    createdAt: nowIso,
    updatedAt: nowIso,
    projectId: draft.projectId.trim(),
    scope: draft.scope ?? 'repo',
    sourceSessionId: draft.sourceSessionId,
    ...core,
    confidence: clampConfidence(draft.confidence),
    relatedEntryIds: normalizeStringList(draft.relatedEntryIds),
    relations: [],
    embeddingText: buildEmbeddingText(core),
    status: 'active',
  };
};

/** Merge a freshly captured entry into an existing duplicate, enriching evidence. */
export const mergeEntries = (existing: ExperienceEntry, incoming: ExperienceEntry, nowIso: string): ExperienceEntry => {
  const merged: ExperienceEntry = {
    ...existing,
    updatedAt: nowIso,
    symptoms: {
      summary: existing.symptoms.summary,
      errorMessages: normalizeStringList([...existing.symptoms.errorMessages, ...incoming.symptoms.errorMessages]),
      stackTraceDigest: existing.symptoms.stackTraceDigest ?? incoming.symptoms.stackTraceDigest,
    },
    context: {
      workspace: existing.context.workspace ?? incoming.context.workspace,
      repoArea: normalizeStringList([...existing.context.repoArea, ...incoming.context.repoArea]),
      files: normalizeStringList([...existing.context.files, ...incoming.context.files]),
      commands: normalizeStringList([...existing.context.commands, ...incoming.context.commands]),
      runtime: existing.context.runtime ?? incoming.context.runtime,
      frameworks: normalizeStringList([...existing.context.frameworks, ...incoming.context.frameworks]),
      packages: normalizeStringList([...existing.context.packages, ...incoming.context.packages]),
      errorCategory: existing.context.errorCategory ?? incoming.context.errorCategory,
    },
    rootCause: existing.rootCause ?? incoming.rootCause,
    fix: existing.fix ?? incoming.fix,
    lesson: existing.lesson.length >= incoming.lesson.length ? existing.lesson : incoming.lesson,
    verification: {
      commands: [...existing.verification.commands, ...incoming.verification.commands],
      confidenceEvidence: normalizeStringList([
        ...existing.verification.confidenceEvidence,
        ...incoming.verification.confidenceEvidence,
      ]),
    },
    tags: normalizeStringList([...existing.tags, ...incoming.tags]),
    // Repeated evidence raises confidence, capped at 0.99.
    confidence: clampConfidence(Math.max(existing.confidence, incoming.confidence) + 0.05, existing.confidence),
  };
  merged.embeddingText = buildEmbeddingText(merged);
  return merged;
};

/** Create a capture service bound to a store and (optional) embedder. */
export const createExperienceCapture = (deps: ExperienceCaptureDeps) => {
  const now = deps.now ?? ((): string => new Date().toISOString());
  const generateId = deps.generateId ?? ((): string => `exp_${randomUUID()}`);

  const embed = async (entry: ExperienceEntry): Promise<ExperienceEntry> => {
    if (!deps.embedder) {
      return entry;
    }
    try {
      const vector = await embedOne(deps.embedder, entry.embeddingText);
      return vector ? { ...entry, vector } : entry;
    } catch {
      // Degrade to lexical-only when embedding fails; never block capture.
      return entry;
    }
  };

  /** Capture one draft: normalize, sanitize, dedupe, embed, persist. */
  const capture = async (draft: ExperienceEntryDraft): Promise<CaptureResult> => {
    const candidate = normalizeDraft(draft, generateId(), now());
    const existingEntries = await deps.store.searchMetadata({ projectId: candidate.projectId, status: 'active' });

    let best: { entry: ExperienceEntry; score: number } | null = null;
    for (const existing of existingEntries) {
      if (existing.kind !== candidate.kind) {
        continue;
      }
      const score = lexicalJaccard(existing.embeddingText, candidate.embeddingText);
      if (!best || score > best.score) {
        best = { entry: existing, score };
      }
    }

    if (best && best.score >= DEDUPE_THRESHOLD) {
      const merged = await embed(mergeEntries(best.entry, candidate, now()));
      const updated = await deps.store.update(merged.id, merged);
      return { entry: updated, action: 'updated' };
    }

    const embedded = await embed(candidate);
    const created = await deps.store.create(embedded);
    return { entry: created, action: 'created' };
  };

  return { capture };
};
