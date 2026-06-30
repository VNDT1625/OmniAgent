/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Refresh pipeline for Realtime Knowledge — turns a fact's question into a fresh,
 * verified candidate value.
 *
 * Flow (mechanisms b + c of the spec):
 *   1. Build a refresh question from the fact's `question`/`topic`.
 *   2. Gather evidence with an injected researcher (a structural subset of the
 *      browser `deepResearch` orchestrator) — multi-source, with citations.
 *   3. Distill the answer into a concrete proposed value via an injected
 *      `extractValue` step (an LLM in production; trivially mockable in tests).
 *   4. Run the {@link IVerificationService} guardrail to decide accept/reject/review.
 *
 * The pipeline performs NO persistence — it returns the decision + proposed value
 * + sources, and the caller ({@link rtkService}) applies it (atomic write +
 * history). All collaborators are injected so the pipeline is decoupled from the
 * concrete browser/LLM stack and fully unit-testable. Network calls run under the
 * caller's lease policy.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { FactSource, KnowledgeFact } from './rtkTypes';
import type { IVerificationService, VerificationCandidate, VerificationDecision } from './verificationService';

/** A research source, a loose structural subset of the deep-research result. */
export type ResearchSource = { url?: string; title?: string; snippet?: string };

/** A researcher — structural subset of the browser `IDeepResearch`. */
export type RtkResearcher = {
  /** Answer `question` end-to-end with citations. Should not reject; return empty answer on miss. */
  research(
    question: string,
    options: { model: string; signal?: AbortSignal }
  ): Promise<{ answer: string; sources: ResearchSource[] }>;
};

/** Distills a concrete value (and optional per-source agreement) from research prose. */
export type ValueExtractor = (input: {
  question: string;
  currentValue: string;
  answer: string;
  sources: ResearchSource[];
  signal?: AbortSignal;
}) => Promise<{ value: string; agreement?: boolean[] }>;

/** Dependencies for {@link createRefreshPipeline}. */
export type RefreshPipelineDeps = {
  researcher: RtkResearcher;
  verifier: IVerificationService;
  /** Distill a concrete value from prose. Defaults to a first-line heuristic. */
  extractValue?: ValueExtractor;
  /** Model id used by the researcher / extractor. */
  model: string;
  /** Clock for `fetchedAt` stamps. Defaults to `Date.now`. */
  now?: () => number;
};

/** The result of one refresh attempt. */
export type RefreshResult = {
  /** The value the sources support (may equal the current value = a re-confirmation). */
  proposedValue: string;
  /** Normalised sources backing the proposed value. */
  sources: FactSource[];
  /** The guardrail decision. */
  decision: VerificationDecision;
};

/** A fact-shaped input for refreshing — only the fields the pipeline reads. */
export type RefreshTarget = Pick<KnowledgeFact, 'topic' | 'question' | 'value' | 'aliases'>;

/** The refresh pipeline. */
export type IRefreshPipeline = {
  refresh(target: RefreshTarget, signal?: AbortSignal): Promise<RefreshResult>;
};

/** Default value distiller: first non-empty line of the research answer. */
const firstLineExtractor: ValueExtractor = async ({ answer }) => {
  const firstLine = answer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return { value: firstLine ?? '' };
};

/** Build the question sent to the researcher. */
const buildRefreshQuestion = (target: RefreshTarget): string => {
  const aliasHint = target.aliases && target.aliases.length > 0 ? ` (also known as: ${target.aliases.join('; ')})` : '';
  return `${target.question}${aliasHint}. Provide the current, up-to-date answer with reliable sources and the date it is valid as of.`;
};

/** Map loose research sources to RTK {@link FactSource}s, dropping URL-less ones. */
const toFactSources = (sources: ResearchSource[], fetchedAt: string): FactSource[] =>
  sources
    .filter((s): s is ResearchSource & { url: string } => typeof s.url === 'string' && s.url.trim().length > 0)
    .map((s) =>
      Object.assign(
        { url: s.url.trim() },
        s.title ? { title: s.title } : {},
        { fetchedAt },
        s.snippet ? { snippet: s.snippet } : {}
      )
    );

/**
 * Create an {@link IRefreshPipeline}.
 *
 * @param deps Researcher + verifier + model (+ optional value extractor / clock).
 */
export const createRefreshPipeline = (deps: RefreshPipelineDeps): IRefreshPipeline => {
  const extractValue = deps.extractValue ?? firstLineExtractor;
  const now = deps.now ?? Date.now;

  const refresh = async (target: RefreshTarget, signal?: AbortSignal): Promise<RefreshResult> => {
    const question = buildRefreshQuestion(target);
    const { answer, sources } = await deps.researcher.research(question, { model: deps.model, signal });
    const fetchedAt = new Date(now()).toISOString();
    const factSources = toFactSources(sources, fetchedAt);

    const distilled = await extractValue({
      question: target.question,
      currentValue: target.value,
      answer,
      sources,
      signal,
    });

    const candidate: VerificationCandidate = {
      currentValue: target.value,
      proposedValue: distilled.value,
      sources: factSources,
      ...(distilled.agreement ? { agreement: distilled.agreement } : {}),
    };
    const decision = deps.verifier.verify(candidate);

    return { proposedValue: distilled.value, sources: factSources, decision };
  };

  return { refresh };
};
