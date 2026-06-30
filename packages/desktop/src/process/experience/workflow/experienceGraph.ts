/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Exp Graph relations (Phase 3).
 *
 * Beyond flat similarity, entries form a small graph: experiences that share a
 * root cause, describe the same symptom, contradict each other (a failed
 * attempt vs a working fix for the same context), or apply to the same
 * subsystem. These typed relations let retrieval surface neighbouring lessons —
 * e.g. "this fix worked, but a related attempt failed; here's why".
 *
 * All functions are pure and deterministic.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type {
  ExperienceEntry,
  ExperienceRelation,
  ExperienceRelatedLesson,
  ExperienceSuggestion,
} from '../experienceTypes';
import { lexicalJaccard } from '../experienceCapture';

/** Similarity threshold for symptom/root-cause relations. */
export const RELATION_SIMILARITY_THRESHOLD = 0.5;
/** Max related lessons attached to a single suggestion during enrichment. */
export const MAX_RELATED_PER_SUGGESTION = 3;

const normalizeLower = (values: readonly string[]): Set<string> => new Set(values.map((value) => value.toLowerCase()));

const hasOverlap = (a: readonly string[], b: readonly string[]): boolean => {
  const setB = normalizeLower(b);
  return a.some((value) => setB.has(value.toLowerCase()));
};

const sharesFile = (a: ExperienceEntry, b: ExperienceEntry): boolean => {
  const normalize = (file: string): string => file.replace(/\\/g, '/').toLowerCase();
  const filesB = b.context.files.map(normalize);
  return a.context.files.some((file) => {
    const fa = normalize(file);
    return filesB.some((fb) => fb === fa || fb.endsWith(fa) || fa.endsWith(fb));
  });
};

const sameContext = (a: ExperienceEntry, b: ExperienceEntry): boolean => {
  const frameworkMatch = hasOverlap(a.context.frameworks, b.context.frameworks);
  const categoryMatch =
    Boolean(a.context.errorCategory) &&
    a.context.errorCategory?.toLowerCase() === b.context.errorCategory?.toLowerCase();
  return frameworkMatch || Boolean(categoryMatch);
};

/**
 * Infer typed relations from `target` to each of `others`. Symmetric relations
 * are emitted on `target`; building relations for every entry yields both
 * directions. Self and cross-project pairs are skipped.
 */
export const inferRelations = (target: ExperienceEntry, others: readonly ExperienceEntry[]): ExperienceRelation[] => {
  const relations: ExperienceRelation[] = [];
  const seen = new Set<string>();
  const add = (type: ExperienceRelation['type'], targetId: string): void => {
    const key = `${type}\u0000${targetId}`;
    if (!seen.has(key)) {
      seen.add(key);
      relations.push({ type, targetId });
    }
  };

  for (const other of others) {
    if (other.id === target.id || other.projectId !== target.projectId || other.status === 'archived') {
      continue;
    }

    const symptomSim = lexicalJaccard(target.symptoms.summary, other.symptoms.summary);
    if (symptomSim >= RELATION_SIMILARITY_THRESHOLD) {
      add('same_symptom_as', other.id);
    }

    if (target.rootCause && other.rootCause) {
      const rootSim = lexicalJaccard(target.rootCause, other.rootCause);
      if (rootSim >= RELATION_SIMILARITY_THRESHOLD) {
        add('same_root_cause', other.id);
      }
    }

    // A failed attempt and a successful fix for the same context contradict.
    const opposingKinds =
      (target.kind === 'failed_attempt' && other.kind === 'successful_fix') ||
      (target.kind === 'successful_fix' && other.kind === 'failed_attempt');
    if (opposingKinds && sameContext(target, other) && symptomSim >= RELATION_SIMILARITY_THRESHOLD * 0.6) {
      add('contradicts', other.id);
    }

    // Same subsystem/file + shared framework => applies to the same area.
    if (sharesFile(target, other) && hasOverlap(target.context.frameworks, other.context.frameworks)) {
      add('applies_to', other.id);
    }
  }

  return relations;
};

/** Recompute relations for every entry in a set (used after capture/rebuild). */
export const recomputeAllRelations = (entries: readonly ExperienceEntry[]): Map<string, ExperienceRelation[]> => {
  const byId = new Map<string, ExperienceRelation[]>();
  for (const entry of entries) {
    byId.set(entry.id, inferRelations(entry, entries));
  }
  return byId;
};

type RelatedSource = {
  id: string;
  kind: ExperienceEntry['kind'];
  status: ExperienceEntry['status'];
  lesson: string;
  relations: ExperienceRelation[];
};

/**
 * Attach graph-derived related lessons to suggestions. For each suggestion's
 * entry, follow its relations to non-archived neighbours and surface their
 * lessons (capped). Contradictions are prioritized — they are the most useful
 * caution signal.
 */
export const enrichSuggestions = (
  suggestions: readonly ExperienceSuggestion[],
  entriesById: ReadonlyMap<string, RelatedSource>
): ExperienceSuggestion[] => {
  const relationPriority: Record<ExperienceRelation['type'], number> = {
    contradicts: 0,
    same_root_cause: 1,
    same_symptom_as: 2,
    applies_to: 3,
    supersedes: 4,
  };

  return suggestions.map((suggestion) => {
    const source = entriesById.get(suggestion.entryId);
    if (!source || source.relations.length === 0) {
      return suggestion;
    }
    const related: ExperienceRelatedLesson[] = source.relations
      .map((relation) => ({ relation, target: entriesById.get(relation.targetId) }))
      .filter(
        (item): item is { relation: ExperienceRelation; target: RelatedSource } =>
          Boolean(item.target) && item.target?.status !== 'archived'
      )
      .toSorted((a, b) => relationPriority[a.relation.type] - relationPriority[b.relation.type])
      .slice(0, MAX_RELATED_PER_SUGGESTION)
      .map(({ relation, target }) => ({
        entryId: target.id,
        relation: relation.type,
        kind: target.kind,
        lesson: target.lesson,
      }));

    if (related.length === 0) {
      return suggestion;
    }
    const caution = [...suggestion.caution];
    if (related.some((item) => item.relation === 'contradicts')) {
      caution.unshift('A related experience CONTRADICTS this one (a failed attempt for the same context exists).');
    }
    return { ...suggestion, related, caution };
  });
};
