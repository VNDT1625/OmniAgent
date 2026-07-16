/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the Smart Terminal command knowledge ("docTerminal").
 *
 * A {@link CommandRecord} captures one distinct command line the user has run,
 * with frequency / recency / success metadata so the suggester can rank "what
 * the user most likely wants" for a given prefix. PURE — types + scoring weight
 * constants only, no I/O.
 */

/** One distinct command line learned by docTerminal. */
export type CommandRecord = {
  /** The command line as run (secrets redacted — see `commandRedact`). */
  command: string;
  /** The program token (basename), e.g. `bun` — used by Smart Fix remap. */
  program: string;
  /** Working directory it was last run in (best-effort; optional). */
  cwd?: string;
  /** Total times it has been run (success + failure). */
  count: number;
  /** Times it finished with exit code 0. */
  successCount: number;
  /** Epoch ms first seen. */
  firstUsedAt: number;
  /** Epoch ms last run. */
  lastUsedAt: number;
  /** Exit code of the most recent run (null if unknown). */
  lastExitCode: number | null;
};

/** A ranked suggestion returned for a prefix. */
export type CommandSuggestion = {
  /** The full suggested command. */
  command: string;
  /** Combined score in [0, 1]. */
  score: number;
  /** The portion after the user's current input (what ghost-text would append). */
  completion: string;
  /** How many times it has been run (for the dropdown). */
  count: number;
};

/** Scoring weights (sum ≈ 1). Exported so tests/tuning can reference them. */
export const SCORE_WEIGHTS = {
  match: 0.5,
  frequency: 0.3,
  recency: 0.2,
} as const;

/** Frequency saturates at this run count (so a 100×-run command isn't unbeatable). */
export const FREQUENCY_CAP = 20;

/** Recency half-life in ms (a command used `HALF_LIFE` ago scores ~0.5 on recency). */
export const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
