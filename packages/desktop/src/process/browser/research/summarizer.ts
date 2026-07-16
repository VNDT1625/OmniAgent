/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Map-reduce summariser for the web-browsing agent's research layer. Long pages
 * and transcripts are currently truncated by the runner at ~4000 chars, so a
 * naive summary only ever describes the *start* of long content. This module
 * fixes that by splitting the source into bounded chunks, summarising each chunk
 * into a faithful factual digest (the "map" step), then merging those partial
 * digests into one final structured summary (the "reduce" step). Short text that
 * already fits in a single chunk skips straight to a single structured "map"
 * call.
 *
 * ## This module is a pure ORCHESTRATION layer
 *
 * It contains **no** real model/provider code. The only collaborator is an
 * injected {@link SummarizerChat} — the same chat-completion shape the runner
 * already uses ({@link AgentChat}) — so production wiring supplies a real
 * provider call while unit tests inject a deterministic, scripted chat stub and
 * assert the routing (single-chunk vs. map-reduce), chunk boundaries, prompt
 * contents (focus/language/truncation note), and the empty-input short-circuit.
 *
 * Process boundary: this is a Main-process (Node.js) module — no DOM APIs. It
 * mirrors the dependency-injection + factory style of `mediaPipeline.ts`
 * (`createX(deps)` returning an interface object).
 */

// ---------------------------------------------------------------------------
// Injected collaborator (shape matches the runner's `AgentChat`)
// ---------------------------------------------------------------------------

/**
 * The chat-completion call used to summarise. Returns the raw assistant message
 * text. Its shape is structurally compatible with the runner's `AgentChat`, so
 * the production provider-backed chat can be passed directly; tests inject a
 * deterministic stub.
 */
export type SummarizerChat = (params: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  signal?: AbortSignal;
}) => Promise<string>;

// ---------------------------------------------------------------------------
// Public data models
// ---------------------------------------------------------------------------

/** Options controlling a single {@link ISummarizer.summarize} call. */
export type SummarizeOptions = {
  /** Model id to drive summarization. */
  model: string;
  /** What the user wants out of the summary (e.g. the original instruction). Optional. */
  focus?: string;
  /** BCP-47-ish language to answer in (e.g. 'vi', 'en'). Optional; default: let the model match the source/instruction. */
  language?: string;
  /** Abort signal. */
  signal?: AbortSignal;
};

/** Result of a {@link ISummarizer.summarize} call. */
export type SummaryResult = {
  /** The final structured summary text (TL;DR + key points). */
  summary: string;
  /** Number of chunks the source was split into. */
  chunks: number;
};

/** Public contract of the map-reduce summariser. */
export type ISummarizer = {
  /** Summarize a (possibly long) text via map-reduce. */
  summarize(text: string, options: SummarizeOptions): Promise<SummaryResult>;
};

/** Dependencies and tunables for {@link createSummarizer}. */
export type SummarizerDeps = {
  /** The chat-completion call used for every map/reduce step. */
  chat: SummarizerChat;
  /** Max characters per chunk fed to the model. Default 8000. */
  chunkChars?: number;
  /** Max number of chunks to process (safety bound). Default 12. */
  maxChunks?: number;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default maximum characters per chunk fed to the model. */
const DEFAULT_CHUNK_CHARS = 8000;

/** Default maximum number of chunks processed (safety bound). */
const DEFAULT_MAX_CHUNKS = 12;

/** Boundary separators tried (in order) before falling back to a hard cut. */
const BOUNDARY_SEPARATORS = ['\n\n', '\n', '. '] as const;

// ---------------------------------------------------------------------------
// Pure chunking helper (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Find the best split index at or before `limit` within `text`, preferring
 * higher-level boundaries (paragraph → line → sentence). Returns the index just
 * *after* the chosen separator so it stays attached to the preceding chunk, or
 * `-1` when no usable boundary exists and the caller must hard-cut.
 */
const findBoundary = (text: string, limit: number): number => {
  for (const separator of BOUNDARY_SEPARATORS) {
    const at = text.lastIndexOf(separator, limit);
    // Require the boundary to make real progress; a boundary at index 0 would
    // produce an empty chunk and loop forever.
    if (at > 0) return at + separator.length;
  }
  return -1;
};

/**
 * Split `text` into chunks no longer than `size` characters, preferring natural
 * boundaries so chunks stay readable. It splits at `"\n\n"` first, then `"\n"`,
 * then `". "`, and only falls back to a hard character cut when none of those
 * boundaries occur within the window. Pure and side-effect free so it can be
 * unit-tested directly.
 *
 * @param text The source text to split.
 * @param size The maximum number of characters per chunk (coerced to >= 1).
 * @returns The ordered chunks; an empty array when `text` is empty.
 */
export const chunkText = (text: string, size: number): string[] => {
  if (text.length === 0) return [];
  const limit = Math.max(1, Math.floor(size));
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const boundary = findBoundary(rest, limit);
    const cut = boundary > 0 ? boundary : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
};

// ---------------------------------------------------------------------------
// Prompt builders (pure)
// ---------------------------------------------------------------------------

/** Append an optional focus/language directive block to a base instruction. */
const withDirectives = (base: string, options: SummarizeOptions): string => {
  const lines = [base];
  if (options.focus && options.focus.trim().length > 0) {
    lines.push(`Focus on what matters for this request: ${options.focus.trim()}`);
  }
  if (options.language && options.language.trim().length > 0) {
    lines.push(`Write the summary in this language: ${options.language.trim()}.`);
  } else {
    lines.push('Write the summary in the same language as the source (or the request, if given).');
  }
  return lines.join('\n');
};

/**
 * System instruction for the "map" step over a single chunk: a concise, faithful
 * digest that preserves the facts/numbers/names a later reduce step needs.
 */
const buildMapSystemPrompt = (index: number, total: number): string =>
  [
    'You are a meticulous summarisation engine.',
    `You are given part ${index + 1} of ${total} of a longer document.`,
    'Produce a concise, factual digest of THIS part only.',
    'Preserve key facts, numbers, names, dates and concrete claims; drop filler and navigation.',
    'Do not invent anything that is not in the text. Do not add a preamble.',
  ].join('\n');

/**
 * System instruction for the final structured summary (used both for the
 * single-chunk fast path and the reduce step). Enforces the TL;DR + key-point
 * shape, faithfulness, and honours focus/language.
 */
const buildFinalSystemPrompt = (options: SummarizeOptions, truncated: boolean): string => {
  const base = [
    'You are a meticulous summarisation engine.',
    'Produce a single structured summary with EXACTLY this shape:',
    '- A first line starting with "TL;DR:" giving a one-line takeaway.',
    '- Then 3 to 7 bullet points, each starting with "- ", capturing the key points.',
    'Be faithful to the source: never invent facts, numbers or names that are not present.',
  ];
  if (truncated) {
    base.push(
      'NOTE: the source was longer than could be processed, so some trailing content was omitted; summarise only what is provided and do not speculate about the missing tail.'
    );
  }
  return withDirectives(base.join('\n'), options);
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an {@link ISummarizer} backed by an injected {@link SummarizerChat}.
 *
 * The returned summariser chunks long input with {@link chunkText}, runs a map
 * step per chunk and a final reduce step, and short-circuits empty input without
 * calling the chat at all. All model behaviour is delegated to `deps.chat`, so
 * the module stays pure orchestration and is fully unit-testable with a scripted
 * stub.
 *
 * @param deps Injected chat collaborator and tunables. See {@link SummarizerDeps}.
 * @returns A ready-to-use map-reduce summariser.
 */
export const createSummarizer = (deps: SummarizerDeps): ISummarizer => {
  const { chat } = deps;
  const chunkChars = deps.chunkChars && deps.chunkChars > 0 ? deps.chunkChars : DEFAULT_CHUNK_CHARS;
  const maxChunks = deps.maxChunks && deps.maxChunks > 0 ? deps.maxChunks : DEFAULT_MAX_CHUNKS;

  /** Run one chat round, building the `[system, user]` message pair. */
  const ask = (system: string, user: string, options: SummarizeOptions): Promise<string> =>
    chat({
      model: options.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      signal: options.signal,
    });

  const summarize = async (text: string, options: SummarizeOptions): Promise<SummaryResult> => {
    const trimmed = text.trim();
    // Empty input → no work, no chat call.
    if (trimmed.length === 0) return { summary: '', chunks: 0 };

    const allChunks = chunkText(trimmed, chunkChars);

    // Single chunk: one "map" call that directly produces the structured summary.
    if (allChunks.length <= 1) {
      const summary = await ask(buildFinalSystemPrompt(options, false), allChunks[0] ?? trimmed, options);
      return { summary: (summary ?? '').trim(), chunks: 1 };
    }

    // Cap the number of chunks for safety; note the truncation in the reduce prompt.
    const truncated = allChunks.length > maxChunks;
    const chunks = truncated ? allChunks.slice(0, maxChunks) : allChunks;

    // Map: summarise each chunk into a faithful partial digest.
    const partials: string[] = [];
    for (let index = 0; index < chunks.length; index++) {
      const digest = await ask(buildMapSystemPrompt(index, chunks.length), chunks[index], options);
      partials.push(`Part ${index + 1}/${chunks.length}:\n${(digest ?? '').trim()}`);
    }

    // Reduce: merge the partial digests into one final structured summary.
    const merged = await ask(buildFinalSystemPrompt(options, truncated), partials.join('\n\n'), options);
    return { summary: (merged ?? '').trim(), chunks: chunks.length };
  };

  return { summarize };
};
