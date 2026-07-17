/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useFileCreator` — drives the Studio "create a new file" flow, including an
 * optional **content-generation agent**: given a short description and (any
 * number of) reference files, it asks the user's model to author the full
 * contents of a brand-new file, then writes that content to disk in the right
 * shape for the file type before the dashboard opens it in the editor.
 *
 * Two creation modes:
 * - **empty** — write a zero-length file (the original behaviour).
 * - **generate** — read the reference files (as text, per adapter kind), prompt
 *   the Main-process `studio.chat` bridge for the file body, then persist it:
 *   `.docx` via the Word bridge, `.xlsx` as CSV via the Office bridge, and every
 *   text/code kind straight through `fs.writeFile`.
 *
 * Generation is only offered for kinds we can synthesise from text
 * ({@link kindSupportsGeneration}); binary kinds (slides/pdf/image/media) fall
 * back to an empty file. Renderer-only: model access goes through
 * {@link studioChatClient}; never touches Node APIs directly.
 */

import { useCallback, useState } from 'react';
import { ipcBridge } from '@/common';
import { resolveAdapterKind, type EditorAdapterKind } from '@renderer/pages/editor/editorRegistry';
import { readDocxText, writeDocxText } from '@renderer/pages/editor/adapters/studioDocxClient';
import { readXlsxCsv, writeXlsxCsv, readPptxText } from '@renderer/pages/editor/adapters/studioOfficeClient';
import { baseName } from '../studioStorage';
import { studioChatClient, type StudioChatMessage } from '../studioChatClient';
import { stripTokenWatermarkNotice } from '@/common/chat/chatLib';

/** Failure arm of the chat envelope (cast target under the no-`strictNullChecks` tsconfig). */
type StudioChatFailure = { ok: false; error: string; code: 'no-model' | 'error' };

/** How a new file's body is produced. */
export type CreateMode = 'empty' | 'generate';

/** Where the creator is in its (short) lifecycle. */
export type CreatorStatus = 'idle' | 'reading' | 'generating' | 'writing';

/** Options for {@link UseFileCreator.create}. */
export type CreateFileOptions = {
  /** Absolute directory the file is written into. */
  dir: string;
  /** File name including extension (e.g. `report.docx`). */
  name: string;
  /** Creation mode — `empty` or AI `generate`. */
  mode: CreateMode;
  /** Model id (required for `generate`). */
  model?: string | null;
  /** What the file should contain (required for `generate`). */
  description?: string;
  /** Absolute paths of optional reference files to ground the generation. */
  references?: string[];
};

/** Public shape returned by {@link useFileCreator}. */
export type UseFileCreator = {
  status: CreatorStatus;
  error: string | null;
  busy: boolean;
  /** Create the file; resolves with its absolute path, or `null` on failure. */
  create: (options: CreateFileOptions) => Promise<string | null>;
  /** Reset the transient error/status (e.g. when reopening the modal). */
  reset: () => void;
};

/** Adapter kinds whose body can be authored from generated text. */
const GENERATABLE_KINDS: ReadonlySet<EditorAdapterKind> = new Set(['text-code', 'raw-text', 'docx', 'spreadsheet']);

/** Whether AI generation can produce a usable body for `fileName`'s type. */
export const kindSupportsGeneration = (fileName: string): boolean =>
  GENERATABLE_KINDS.has(resolveAdapterKind({ fileName: baseName(fileName) }));

/** Per-reference and total character budgets so prompts stay reasonable. */
const MAX_REF_CHARS = 6000;
const MAX_REFERENCES = 5;

/** Join a directory and a file name with the right separator for the path style. */
const joinPath = (dir: string, name: string): string => {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${dir.replace(/[/\\]+$/, '')}${sep}${name}`;
};

/**
 * Strip a single outer ```fence``` if the whole reply is one fenced block, so
 * generated content lands in the file without stray Markdown fences. A reply
 * that is genuinely Markdown (multiple blocks / prose) is left untouched.
 */
const stripOuterFence = (text: string): string => {
  const trimmed = text.trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match ? match[1] : text;
};

/** Read one reference file as text, per its adapter kind. Unreadable kinds → ''. */
const readReference = async (path: string): Promise<string> => {
  const kind = resolveAdapterKind({ fileName: baseName(path) });
  try {
    if (kind === 'docx') return await readDocxText(path);
    if (kind === 'spreadsheet') return await readXlsxCsv(path);
    if (kind === 'slide') return await readPptxText(path);
    if (kind === 'text-code' || kind === 'raw-text') {
      return (await ipcBridge.fs.readFile.invoke({ path })) ?? '';
    }
  } catch {
    /* a single unreadable reference must not abort the whole generation */
  }
  return '';
};

/** Short, kind-specific guidance telling the model what shape the body must take. */
const formatGuidance = (kind: EditorAdapterKind, name: string): string => {
  switch (kind) {
    case 'spreadsheet':
      return 'Output valid CSV only (comma-separated, one row per line, header row first). No prose, no Markdown.';
    case 'docx':
      return 'Output the document body as plain text, one paragraph per line. No Markdown syntax.';
    case 'text-code': {
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
      if (ext === 'md' || ext === 'markdown') return 'Output well-structured Markdown.';
      return 'Output only the file contents (raw code/text), with no explanations and no surrounding code fences.';
    }
    default:
      return 'Output only the file contents, with no explanations.';
  }
};

/** Build the system + user messages that ask the model to author the file body. */
const buildMessages = (
  name: string,
  kind: EditorAdapterKind,
  description: string,
  refs: { name: string; text: string }[]
): StudioChatMessage[] => {
  const referenceBlock =
    refs.length === 0
      ? ''
      : [
          '',
          'Reference materials provided by the user:',
          ...refs.map((r) =>
            [
              '',
              `--- ${r.name} ---`,
              r.text.length > MAX_REF_CHARS ? `${r.text.slice(0, MAX_REF_CHARS)}\n…(truncated)` : r.text,
            ].join('\n')
          ),
        ].join('\n');

  const system = [
    'You are a content-generation agent in a document studio.',
    'Author the COMPLETE contents of a new file from the user request.',
    `Target file: "${name}".`,
    formatGuidance(kind, name),
    'Return ONLY the file body — never add commentary before or after it.',
  ].join('\n');

  const user = [`Create the contents of "${name}".`, '', 'Description:', description, referenceBlock].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
};

/** Write generated text into `fullPath` in the right shape for its kind. */
const writeContent = async (fullPath: string, kind: EditorAdapterKind, content: string): Promise<void> => {
  if (kind === 'docx') {
    await writeDocxText(fullPath, content);
    return;
  }
  if (kind === 'spreadsheet') {
    await writeXlsxCsv(fullPath, content);
    return;
  }
  const ok = await ipcBridge.fs.writeFile.invoke({ path: fullPath, data: content });
  if (!ok) throw new Error('write-failed');
};

/**
 * Manage the Studio create-file flow (empty or AI-generated).
 */
export const useFileCreator = (): UseFileCreator => {
  const [status, setStatus] = useState<CreatorStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback((): void => {
    setStatus('idle');
    setError(null);
  }, []);

  const create = useCallback(async (options: CreateFileOptions): Promise<string | null> => {
    const name = options.name.trim();
    if (name.length === 0 || options.dir.length === 0) return null;
    const fullPath = joinPath(options.dir, name);
    const kind = resolveAdapterKind({ fileName: name });
    setError(null);

    // Empty mode (or a kind we cannot synthesise) → write a zero-length file.
    if (options.mode === 'empty' || !GENERATABLE_KINDS.has(kind)) {
      setStatus('writing');
      try {
        const ok = await ipcBridge.fs.writeFile.invoke({ path: fullPath, data: '' });
        if (!ok) throw new Error('write-failed');
        return fullPath;
      } catch {
        setError('failed');
        return null;
      } finally {
        setStatus('idle');
      }
    }

    // Generate mode.
    const description = (options.description ?? '').trim();
    if (!options.model) {
      setError('no-model');
      return null;
    }
    if (description.length === 0) {
      setError('no-description');
      return null;
    }

    try {
      const paths = (options.references ?? []).slice(0, MAX_REFERENCES);
      const refs: { name: string; text: string }[] = [];
      if (paths.length > 0) {
        setStatus('reading');
        for (const path of paths) {
          const text = await readReference(path);
          if (text.trim().length > 0) refs.push({ name: baseName(path), text });
        }
      }

      setStatus('generating');
      const messages = buildMessages(name, kind, description, refs);
      const result = await studioChatClient.chat.invoke({ model: options.model, messages, workspace: options.dir });
      if (!result.ok) {
        const failure = result as StudioChatFailure;
        setError(failure.code === 'no-model' ? 'no-model' : 'generate-failed');
        return null;
      }

      setStatus('writing');
      const clean = stripTokenWatermarkNotice(result.data).trim();
      await writeContent(fullPath, kind, stripOuterFence(clean));
      return fullPath;
    } catch {
      setError('generate-failed');
      return null;
    } finally {
      setStatus('idle');
    }
  }, []);

  return { status, error, busy: status !== 'idle', create, reset };
};

export default useFileCreator;
