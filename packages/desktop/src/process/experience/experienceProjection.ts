/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MTUI projection layer for the ExpBase engine.
 *
 * The TS engine owns embeddings and the canonical store. To let the AI-free
 * MTUI Rust CLI rank experiences without calling a model, the engine writes a
 * compact projection file that MTUI reads (mirroring how MTUI reads the
 * Understand `summary.json`):
 *
 * ```
 * <projectRoot>/.mtui/exp/index.json     # vectors + metadata projection (engine -> MTUI)
 * <projectRoot>/.mtui/exp/inbox.jsonl    # drafts queued by `mtui exp add` (MTUI -> engine)
 * ```
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EXPERIENCE_PROJECTION_VERSION,
  type ExperienceEntry,
  type ExperienceFeedbackItem,
  type ExperienceInboxItem,
  type ExperienceProjection,
  type ExperienceProjectionEntry,
} from './experienceTypes';
import { buildLexicalText, computeVerificationStrength } from './experienceText';

/** Directory (under a project root) holding MTUI's ExpBase projection + inbox. */
export const MTUI_EXP_DIR = path.join('.mtui', 'exp');
const PROJECTION_FILE = 'index.json';
const INBOX_FILE = 'inbox.jsonl';
const FORGET_FILE = 'forget.jsonl';
const FEEDBACK_FILE = 'feedback.jsonl';

/** Minimal filesystem surface used by the projection layer; injectable for tests. */
export type ProjectionFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8' }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
  rm(filePath: string, options: { force: true }): Promise<void>;
};

/** Default adapter backed by Node's `fs/promises`. */
export const defaultProjectionFs: ProjectionFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
  rm: (filePath, options) => fs.promises.rm(filePath, options),
};

const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/** Cautions an agent should heed before reusing an entry. */
export const buildCaution = (entry: ExperienceEntry, verificationStrength: number): string[] => {
  const caution: string[] = [];
  if (entry.status === 'superseded') {
    caution.push('This experience was superseded by a newer entry; prefer the replacement.');
  }
  if (entry.status === 'archived') {
    caution.push('This experience is archived; treat as historical only.');
  }
  if (entry.kind === 'failed_attempt') {
    caution.push('This records a failed attempt: the described approach did NOT work.');
  }
  if (entry.kind === 'agent_mistake') {
    caution.push('This records a past mistake to avoid, not a fix to apply.');
  }
  if (verificationStrength < 0.4) {
    caution.push('Verification evidence is weak; confirm the fix before relying on it.');
  }
  caution.push('Confirm the current framework/version and context match before applying.');
  return caution;
};

/** Concrete checks an agent can run, derived from passed verification commands. */
export const buildSuggestedChecks = (entry: ExperienceEntry): string[] => {
  const checks = (entry.verification.commands ?? [])
    .filter((command) => command.outcome === 'passed')
    .map((command) => `Run: ${command.command}`);
  if (entry.context.commands.length > 0) {
    for (const command of entry.context.commands) {
      const check = `Reproduce with: ${command}`;
      if (!checks.includes(check)) {
        checks.push(check);
      }
    }
  }
  return checks;
};

/** Flatten a full entry into the compact MTUI projection representation. */
export const toProjectionEntry = (entry: ExperienceEntry): ExperienceProjectionEntry => {
  const verificationStrength = computeVerificationStrength(entry.verification);
  const base = {
    id: entry.id,
    scope: entry.scope ?? 'repo',
    kind: entry.kind,
    status: entry.status,
    symptom: entry.symptoms.summary,
    lesson: entry.lesson,
    tags: entry.tags,
    frameworks: entry.context.frameworks,
    packages: entry.context.packages,
    files: entry.context.files,
    commands: entry.context.commands,
    errorCategory: entry.context.errorCategory,
    confidence: entry.confidence,
    verificationStrength,
    updatedAt: entry.updatedAt,
    caution: buildCaution(entry, verificationStrength),
    suggestedChecks: buildSuggestedChecks(entry),
    relations: entry.relations ?? [],
    vector: entry.vector,
  };
  const lexicalText = buildLexicalText({
    ...base,
    errorMessages: entry.symptoms.errorMessages,
    rootCause: entry.rootCause,
  });
  return { ...base, lexicalText };
};

/** Build the full projection document from a set of entries. */
export const buildProjection = (
  entries: readonly ExperienceEntry[],
  meta: { providerId?: string; model?: string; now?: () => number } = {}
): ExperienceProjection => {
  const projectionEntries = entries.map(toProjectionEntry);
  const dimensions = projectionEntries.find((entry) => entry.vector && entry.vector.length > 0)?.vector?.length ?? 0;
  return {
    version: EXPERIENCE_PROJECTION_VERSION,
    providerId: meta.providerId,
    model: meta.model,
    dimensions,
    builtAt: (meta.now ?? Date.now)(),
    entries: projectionEntries,
  };
};

const resolveExpDir = (projectRoot: string): string => path.join(projectRoot, MTUI_EXP_DIR);

/** Atomically write the MTUI projection file for a project root. */
export const writeProjection = async (
  projectRoot: string,
  projection: ExperienceProjection,
  fsImpl: ProjectionFs = defaultProjectionFs
): Promise<string> => {
  const dir = resolveExpDir(projectRoot);
  await fsImpl.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, PROJECTION_FILE);
  const tmpPath = `${filePath}.tmp`;
  await fsImpl.writeFile(tmpPath, JSON.stringify(projection, null, 2), { encoding: 'utf-8' });
  await fsImpl.rename(tmpPath, filePath);
  return filePath;
};

/** Read the MTUI projection file; returns `null` when it does not exist. */
export const readProjection = async (
  projectRoot: string,
  fsImpl: ProjectionFs = defaultProjectionFs
): Promise<ExperienceProjection | null> => {
  const filePath = path.join(resolveExpDir(projectRoot), PROJECTION_FILE);
  try {
    return JSON.parse(await fsImpl.readFile(filePath, 'utf-8')) as ExperienceProjection;
  } catch (error) {
    if (isFileNotFound(error)) {
      return null;
    }
    throw error;
  }
};

/** Read and parse the `mtui exp add` inbox; tolerant of malformed lines. */
export const readInbox = async (
  projectRoot: string,
  fsImpl: ProjectionFs = defaultProjectionFs
): Promise<ExperienceInboxItem[]> => {
  const filePath = path.join(resolveExpDir(projectRoot), INBOX_FILE);
  let raw: string;
  try {
    raw = await fsImpl.readFile(filePath, 'utf-8');
  } catch (error) {
    if (isFileNotFound(error)) {
      return [];
    }
    throw error;
  }
  const items: ExperienceInboxItem[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      items.push(JSON.parse(trimmed) as ExperienceInboxItem);
    } catch {
      // Skip malformed lines rather than failing the whole drain.
    }
  }
  return items;
};

/** Append one draft to the inbox (used by tests and any TS-side queueing). */
export const appendInbox = async (
  projectRoot: string,
  item: ExperienceInboxItem,
  fsImpl: ProjectionFs = defaultProjectionFs
): Promise<void> => {
  const dir = resolveExpDir(projectRoot);
  await fsImpl.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, INBOX_FILE);
  let existing = '';
  try {
    existing = await fsImpl.readFile(filePath, 'utf-8');
  } catch (error) {
    if (!isFileNotFound(error)) {
      throw error;
    }
  }
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing;
  const tmpPath = `${filePath}.tmp`;
  await fsImpl.writeFile(tmpPath, `${prefix}${JSON.stringify(item)}\n`, { encoding: 'utf-8' });
  await fsImpl.rename(tmpPath, filePath);
};

/** Clear the inbox after a successful drain. */
export const clearInbox = async (projectRoot: string, fsImpl: ProjectionFs = defaultProjectionFs): Promise<void> => {
  const filePath = path.join(resolveExpDir(projectRoot), INBOX_FILE);
  await fsImpl.rm(filePath, { force: true });
};

/** Read the `mtui exp forget` queue (one entry id per line). */
export const readForget = async (
  projectRoot: string,
  fsImpl: ProjectionFs = defaultProjectionFs
): Promise<string[]> => {
  const filePath = path.join(resolveExpDir(projectRoot), FORGET_FILE);
  try {
    const raw = await fsImpl.readFile(filePath, 'utf-8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (error) {
    if (isFileNotFound(error)) {
      return [];
    }
    throw error;
  }
};

/** Clear the forget queue after processing. */
export const clearForget = async (projectRoot: string, fsImpl: ProjectionFs = defaultProjectionFs): Promise<void> => {
  const filePath = path.join(resolveExpDir(projectRoot), FORGET_FILE);
  await fsImpl.rm(filePath, { force: true });
};

/** Read the `mtui exp feedback` queue; tolerant of malformed lines. */
export const readFeedback = async (
  projectRoot: string,
  fsImpl: ProjectionFs = defaultProjectionFs
): Promise<ExperienceFeedbackItem[]> => {
  const filePath = path.join(resolveExpDir(projectRoot), FEEDBACK_FILE);
  let raw: string;
  try {
    raw = await fsImpl.readFile(filePath, 'utf-8');
  } catch (error) {
    if (isFileNotFound(error)) {
      return [];
    }
    throw error;
  }
  const items: ExperienceFeedbackItem[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as ExperienceFeedbackItem;
      if (typeof parsed.id === 'string' && typeof parsed.helped === 'boolean') {
        items.push(parsed);
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return items;
};

/** Append one feedback item to the queue (used by tests). */
export const appendFeedback = async (
  projectRoot: string,
  item: ExperienceFeedbackItem,
  fsImpl: ProjectionFs = defaultProjectionFs
): Promise<void> => {
  const dir = resolveExpDir(projectRoot);
  await fsImpl.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, FEEDBACK_FILE);
  let existing = '';
  try {
    existing = await fsImpl.readFile(filePath, 'utf-8');
  } catch (error) {
    if (!isFileNotFound(error)) {
      throw error;
    }
  }
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing;
  const tmpPath = `${filePath}.tmp`;
  await fsImpl.writeFile(tmpPath, `${prefix}${JSON.stringify(item)}\n`, { encoding: 'utf-8' });
  await fsImpl.rename(tmpPath, filePath);
};

/** Clear the feedback queue after processing. */
export const clearFeedback = async (projectRoot: string, fsImpl: ProjectionFs = defaultProjectionFs): Promise<void> => {
  const filePath = path.join(resolveExpDir(projectRoot), FEEDBACK_FILE);
  await fsImpl.rm(filePath, { force: true });
};
