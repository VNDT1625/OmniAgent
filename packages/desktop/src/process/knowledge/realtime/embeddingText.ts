/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PURE builder for a fact's embedding text.
 *
 * The embedding text is the string fed to the {@link Embedder} so that a user's
 * natural-language question retrieves the right fact. It fuses the normalised
 * topic, the canonical question, alias phrasings, tags and the current value so
 * both "what is the latest Node LTS" and "newest nodejs version" land near the
 * `nodejs.lts.version` fact.
 *
 * No I/O. Mirrors the template style of `exp-graph/design.md`.
 */

import type { FactDraft, KnowledgeFact } from './rtkTypes';

/** Fields needed to build embedding text — a structural subset of a fact/draft. */
export type EmbeddingTextInput = Pick<KnowledgeFact, 'topic' | 'question' | 'value'> &
  Partial<Pick<KnowledgeFact, 'aliases' | 'tags' | 'volatilityClass'>>;

/** Collapse whitespace and trim a line so the template stays compact. */
const tidy = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Build the semantic embedding text for a fact or draft.
 *
 * @param input Topic, question and value (plus optional aliases/tags/class).
 * @returns A compact multi-line string suitable for embedding.
 */
export const buildEmbeddingText = (input: EmbeddingTextInput): string => {
  const aliases = (input.aliases ?? []).map(tidy).filter((a) => a.length > 0);
  const tags = (input.tags ?? []).map(tidy).filter((t) => t.length > 0);
  const lines = [
    `Topic: ${tidy(input.topic)}`,
    `Question: ${tidy(input.question)}`,
    aliases.length > 0 ? `Also asked as: ${aliases.join(' | ')}` : '',
    input.volatilityClass ? `Kind: ${input.volatilityClass}` : '',
    `Value: ${tidy(input.value)}`,
    tags.length > 0 ? `Tags: ${tags.join(', ')}` : '',
  ];
  return lines.filter((line) => line.length > 0).join('\n');
};

/** Convenience: build embedding text from a {@link FactDraft}. */
export const embeddingTextFromDraft = (draft: FactDraft): string =>
  buildEmbeddingText({
    topic: draft.topic,
    question: draft.question,
    value: draft.value,
    aliases: draft.aliases,
    tags: draft.tags,
    volatilityClass: draft.volatilityClass,
  });
