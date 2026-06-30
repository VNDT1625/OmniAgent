/**
 * @license
 * Copyright 2025 Omni Project
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `wikiRefine` — the author → self-evaluate → improve loop for ONE wiki section.
 *
 * The production-grade wiki does not write a section once and hope. It:
 *   1. drafts the section (the writer "agent"),
 *   2. {@link critiqueSection | self-evaluates} it deterministically against the
 *      repo's real files and the brief (the reviewer "agent"),
 *   3. asks the model to fix the concrete problems found, and
 *   4. repeats — always keeping the best draft so far — until the section can no
 *      longer be improved ({@link hasConverged}: it is excellent, or a pass
 *      stops yielding a meaningful gain) or a hard iteration cap is reached.
 *
 * The chat call is INJECTED so the loop is unit-testable with a fake model that
 * improves deterministically; the critic is pure. This is the runtime embodiment
 * of "complete until it can no longer be optimised".
 *
 * Process boundary: shared module. No DOM / Node APIs.
 */

import {
  critiqueSection,
  hasConverged,
  type ConvergenceOptions,
  type Critique,
  type WikiCritiqueFacts,
} from './wikiCritic';

/** A single-shot model call: returns the raw completion for system+user. */
export type RefineChat = (system: string, user: string, signal?: AbortSignal) => Promise<string>;

/** Everything needed to author + refine one section. */
export type RefineSectionInput = {
  /** Persona/system prompt for authoring (persona + language + outline + root). */
  system: string;
  /** The grounding user prompt: "Write the X section… What to cover… <digests>". */
  groundingUser: string;
  /** Ground truth for the critic (repo files, key files, brief keywords, …). */
  facts: WikiCritiqueFacts;
};

/** The outcome of refining one section. */
export type RefineResult = {
  /** The best Markdown produced across all passes. */
  content: string;
  /** Critique of the returned (best) content. */
  critique: Critique;
  /** Score history, one entry per produced draft (oldest first). */
  scores: number[];
  /** Number of improvement passes beyond the initial draft. */
  iterations: number;
  /** Whether the loop stopped because the section converged (vs hit the cap). */
  converged: boolean;
};

/** Compose the "improve this draft" user prompt from the critique guidance. */
const buildImprovePrompt = (groundingUser: string, draft: string, guidance: string): string =>
  `${groundingUser}\n\n` +
  `Here is the current draft of this section:\n\n"""\n${draft}\n"""\n\n` +
  `${guidance}\n\n` +
  'Rewrite the COMPLETE improved section as Markdown. Keep everything that is already correct, fix the listed problems, ' +
  'and do not add a top-level title. Output only the section Markdown, no preamble.';

/**
 * Author one section then iteratively improve it until it converges. Always
 * returns the highest-scoring draft seen (so an improvement pass can never make
 * the result worse than a previous one). Throws only if the very first draft
 * call rejects; later failed passes are swallowed and the best-so-far is kept.
 */
export const refineSection = async (
  chat: RefineChat,
  input: RefineSectionInput,
  opts: ConvergenceOptions & { signal?: AbortSignal }
): Promise<RefineResult> => {
  // 1) Initial draft (the writer agent). A failure here is fatal for the section.
  const draft = await chat(input.system, input.groundingUser, opts.signal);
  let best = draft;
  let bestCritique = critiqueSection(best, input.facts);
  const scores: number[] = [bestCritique.score];
  let iterations = 0;

  // 2) Improve while the section keeps getting meaningfully better.
  while (!hasConverged(scores, opts)) {
    if (opts.signal?.aborted) break;
    iterations += 1;
    let candidate: string;
    try {
      // eslint-disable-next-line no-await-in-loop -- each pass improves the previous draft, so passes are inherently sequential.
      candidate = await chat(
        input.system,
        buildImprovePrompt(input.groundingUser, best, bestCritique.guidance),
        opts.signal
      );
    } catch {
      // A failed improve pass should not lose the best draft; stop improving.
      break;
    }
    const candidateCritique = critiqueSection(candidate, input.facts);
    scores.push(candidateCritique.score);
    if (candidateCritique.score > bestCritique.score) {
      best = candidate;
      bestCritique = candidateCritique;
    }
  }

  return {
    content: best,
    critique: bestCritique,
    scores,
    iterations,
    converged: bestCritique.score >= (opts.highScore ?? 0.95) || scores.length >= 2,
  };
};
