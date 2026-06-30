/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure text helpers for the ExpBase engine: secret redaction, deterministic
 * embedding-text generation, lexical token-soup generation, and small scoring
 * utilities. No I/O, no model calls — safe and fast to unit test.
 */

import type {
  ExperienceContext,
  ExperienceEntry,
  ExperienceProjectionEntry,
  ExperienceVerification,
} from './experienceTypes';

/** Regexes that match common secret shapes. Order matters (longest first). */
const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // Bearer tokens / Authorization headers.
  { pattern: /\b(bearer|token|authorization)\b\s*[:=]?\s*[A-Za-z0-9._~+/-]{12,}=*/gi, replacement: '$1 [REDACTED]' },
  // key=value / "secret": "value" style assignments for sensitive names.
  {
    pattern:
      /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|password|passwd|token|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*)\b\s*[:=]\s*["']?[^\s"']{6,}["']?/gi,
    replacement: '$1=[REDACTED]',
  },
  // Common provider key prefixes (OpenAI, GitHub, Slack, AWS, Google).
  { pattern: /\b(sk|pk|rk)-[A-Za-z0-9]{16,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g, replacement: '[REDACTED]' },
  // Credentials embedded in a URL/connection string: scheme://user:password@host.
  { pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/\s@]+:)[^@/\s]+(@)/g, replacement: '$1[REDACTED]$2' },
  // JWTs: three base64url segments.
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: '[REDACTED]' },
];

/**
 * Redact likely secrets/tokens from free text while keeping the surrounding
 * structure (so stack traces remain useful). Idempotent.
 */
export const redactSecrets = (text: string): string => {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
};

/** Redact secrets from every string in a list, dropping empties. */
export const redactList = (values: readonly string[] | undefined): string[] =>
  (values ?? []).map((value) => redactSecrets(value).trim()).filter((value) => value.length > 0);

/** Clamp a confidence value into `[0, 1]`, defaulting non-finite input to `fallback`. */
export const clampConfidence = (value: number | undefined, fallback = 0.5): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
};

/** Trim, drop empties, and de-duplicate (case-insensitive) a list of strings. */
export const normalizeStringList = (values: readonly string[] | undefined): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values ?? []) {
    const value = raw.trim();
    if (value.length === 0) {
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
};

/**
 * Derive a `[0, 1]` strength from verification evidence: passed commands and
 * concrete evidence raise it; failed/not-run commands and no evidence lower it.
 */
export const computeVerificationStrength = (verification: ExperienceVerification): number => {
  const commands = verification.commands ?? [];
  const evidence = verification.confidenceEvidence ?? [];
  if (commands.length === 0 && evidence.length === 0) {
    return 0.1;
  }
  const passed = commands.filter((command) => command.outcome === 'passed').length;
  const failed = commands.filter((command) => command.outcome === 'failed').length;
  const ran = commands.length;
  const commandScore = ran === 0 ? 0.3 : (passed - failed * 0.5) / ran;
  const evidenceBonus = Math.min(0.3, evidence.length * 0.1);
  return clampConfidence(0.2 + commandScore * 0.5 + evidenceBonus, 0.3);
};

/** Join non-empty parts with a separator, trimming each. */
const joinParts = (parts: ReadonlyArray<string | undefined>, separator: string): string =>
  parts
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0)
    .join(separator);

const contextLine = (context: ExperienceContext): string =>
  joinParts(
    [
      context.repoArea.length > 0 ? `area ${context.repoArea.join(', ')}` : '',
      context.frameworks.length > 0 ? `frameworks ${context.frameworks.join(', ')}` : '',
      context.packages.length > 0 ? `packages ${context.packages.join(', ')}` : '',
      context.commands.length > 0 ? `commands ${context.commands.join(', ')}` : '',
      context.files.length > 0 ? `files ${context.files.join(', ')}` : '',
      context.runtime ? `runtime ${context.runtime}` : '',
      context.errorCategory ? `errorClass ${context.errorCategory}` : '',
    ],
    '; '
  );

/**
 * Build the deterministic `embeddingText` for an entry. Same entry content
 * always produces the same text, so re-embedding is reproducible.
 */
export const buildEmbeddingText = (
  entry: Pick<
    ExperienceEntry,
    'kind' | 'symptoms' | 'context' | 'rootCause' | 'fix' | 'lesson' | 'verification' | 'tags'
  >
): string => {
  const passedCommands = (entry.verification.commands ?? [])
    .filter((command) => command.outcome === 'passed')
    .map((command) => command.command);
  return joinParts(
    [
      `Kind: ${entry.kind}`,
      `Symptoms: ${joinParts([entry.symptoms.summary, ...(entry.symptoms.errorMessages ?? [])], ' | ')}`,
      entry.symptoms.stackTraceDigest ? `Stack: ${entry.symptoms.stackTraceDigest}` : '',
      `Context: ${contextLine(entry.context)}`,
      entry.rootCause ? `Root cause: ${entry.rootCause}` : '',
      entry.fix ? `Fix: ${joinParts([entry.fix.summary, ...(entry.fix.steps ?? [])], ' | ')}` : '',
      entry.lesson ? `Lesson: ${entry.lesson}` : '',
      passedCommands.length > 0 ? `Verification: ${passedCommands.join(', ')}` : '',
      entry.tags.length > 0 ? `Tags: ${entry.tags.join(', ')}` : '',
    ],
    '\n'
  );
};

/**
 * Build the lower-cased lexical token soup used by MTUI's no-model ranking.
 * Includes symptom, lesson, root cause, tags, and context identifiers.
 */
export const buildLexicalText = (
  source: Pick<
    ExperienceProjectionEntry,
    'symptom' | 'lesson' | 'tags' | 'frameworks' | 'packages' | 'files' | 'commands' | 'errorCategory'
  > & {
    errorMessages?: string[];
    rootCause?: string;
  }
): string =>
  joinParts(
    [
      source.symptom,
      ...(source.errorMessages ?? []),
      source.rootCause,
      source.lesson,
      source.tags.join(' '),
      source.frameworks.join(' '),
      source.packages.join(' '),
      source.files.join(' '),
      source.commands.join(' '),
      source.errorCategory,
    ],
    ' '
  ).toLowerCase();

/** Split text into lower-cased word tokens for lexical comparison. */
export const tokenize = (text: string): string[] => text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
