/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Markdown-normalise model messages before they are sent to provider or CLI
 * agents. This gives every main-process AI surface the same document handling:
 * local file paths are expanded through the shared content-extraction service
 * (markitdown via uvx first, Node parsers as fallback), while large HTML blobs
 * are converted to Markdown with turndown.
 *
 * Process boundary: Main-process only. Uses Node filesystem APIs and the
 * contentExtract service; renderer code must not import this module directly.
 */

import { stat as fsStat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getContentExtractService, type ExtractOutcome, type ExtractVia } from '@process/services/contentExtract';
import type { ChatContent, ChatMessageInput } from '@process/browser/webAgentRunner';

type ChatPart = Exclude<ChatContent, string>[number];
type TextChatPart = Extract<ChatPart, { type: 'text' }>;

type ContentExtractor = {
  extract(
    source: { kind: 'file'; path: string } | { kind: 'html'; html: string; title?: string }
  ): Promise<ExtractOutcome>;
};

type FileStat = {
  isFile(): boolean;
};

export type MarkdownMessageNormalizerDeps = {
  extract?: ContentExtractor;
  stat?: (path: string) => Promise<FileStat>;
  maxFilesPerMessage?: number;
  maxExtractedCharsPerFile?: number;
  longTextThreshold?: number;
};

const DEFAULT_MAX_FILES_PER_MESSAGE = 4;
const DEFAULT_MAX_EXTRACTED_CHARS_PER_FILE = 30000;
const DEFAULT_LONG_TEXT_THRESHOLD = 12000;

const WINDOWS_PATH_RE = /(?:file:\/\/\/)?[A-Za-z]:[\\/][^\r\n"'<>|]+?\.[A-Za-z0-9]{1,10}/g;
const HTML_TAG_RE = /<\/?(?:html|body|article|main|section|div|p|table|tr|td|th|h[1-6]|ul|ol|li|pre|code|span|a)\b/i;

const trimCandidate = (value: string): string =>
  value
    .trim()
    .replace(/[),.;\]}]+$/g, '')
    .trim();

const decodeFileCandidate = (candidate: string): string => {
  const cleaned = trimCandidate(candidate);
  if (/^file:\/\//i.test(cleaned)) {
    try {
      return fileURLToPath(cleaned);
    } catch {
      return cleaned.replace(/^file:\/\/\/?/i, '');
    }
  }
  return cleaned;
};

const collectFilePathCandidates = (content: string, max: number): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(WINDOWS_PATH_RE)) {
    const candidate = decodeFileCandidate(match[0]);
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= max) break;
  }
  return out;
};

const looksLikeLongHtml = (content: string, threshold: number): boolean => {
  if (content.length < threshold) return false;
  return HTML_TAG_RE.test(content);
};

const viaLabel = (via: ExtractVia | undefined): string => (via ? `via: ${via}` : 'via: unknown');

const markdownFileBlock = (path: string, outcome: ExtractOutcome, maxChars: number): string | null => {
  if (!outcome.ok) return null;
  const text = outcome.text.trim();
  if (text.length === 0) return null;
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[truncated]` : text;
  return [`### ${path}`, `_Converted to Markdown/text (${viaLabel(outcome.via)})._`, '', clipped].join('\n');
};

const appendExtractedFiles = async (
  content: string,
  deps: Required<
    Pick<MarkdownMessageNormalizerDeps, 'extract' | 'stat' | 'maxFilesPerMessage' | 'maxExtractedCharsPerFile'>
  >
): Promise<string> => {
  const paths = collectFilePathCandidates(content, deps.maxFilesPerMessage);
  if (paths.length === 0) return content;

  const blocks = await Promise.all(
    paths.map(async (path): Promise<string | null> => {
      try {
        const info = await deps.stat(path);
        if (!info.isFile()) return null;
        const outcome = await deps.extract.extract({ kind: 'file', path });
        return markdownFileBlock(path, outcome, deps.maxExtractedCharsPerFile);
      } catch {
        // Best-effort: a missing/unreadable path must never block a chat turn.
        return null;
      }
    })
  );
  const present = blocks.filter((block): block is string => block !== null);
  if (present.length === 0) return content;
  return [content, '## AionUi extracted file context', ...present].join('\n\n');
};

const normalizeStringContent = async (
  content: string,
  deps: Required<
    Pick<
      MarkdownMessageNormalizerDeps,
      'extract' | 'stat' | 'maxFilesPerMessage' | 'maxExtractedCharsPerFile' | 'longTextThreshold'
    >
  >
): Promise<string> => {
  let normalized = content;
  if (looksLikeLongHtml(content, deps.longTextThreshold)) {
    try {
      const outcome = await deps.extract.extract({ kind: 'html', html: content, title: 'Long HTML content' });
      if (outcome.ok && outcome.text.trim().length > 0) {
        normalized = [
          '## AionUi Markdown-normalized content',
          '_The original long HTML was converted to Markdown before sending it to the model._',
          '',
          outcome.text.trim(),
        ].join('\n');
      }
    } catch {
      // Best-effort: keep the original content on conversion failure.
    }
  }
  return appendExtractedFiles(normalized, deps);
};

const isTextPart = (part: ChatPart): part is TextChatPart =>
  part.type === 'text' && typeof (part as { text?: unknown }).text === 'string';

const normalizeContent = async (
  content: ChatContent,
  deps: Required<
    Pick<
      MarkdownMessageNormalizerDeps,
      'extract' | 'stat' | 'maxFilesPerMessage' | 'maxExtractedCharsPerFile' | 'longTextThreshold'
    >
  >
): Promise<ChatContent> => {
  if (typeof content === 'string') return normalizeStringContent(content, deps);
  const mapped = await Promise.all(
    content.map(async (part) =>
      isTextPart(part) ? { ...part, text: await normalizeStringContent(part.text, deps) } : part
    )
  );
  return mapped;
};

/**
 * Convert file references and large HTML payloads inside chat messages into
 * Markdown-friendly content. Returns the original message shape when there is
 * nothing to normalize.
 */
export const normalizeChatMessagesForMarkdown = async (
  messages: ChatMessageInput[],
  deps: MarkdownMessageNormalizerDeps = {}
): Promise<ChatMessageInput[]> => {
  const resolved = {
    extract: deps.extract ?? getContentExtractService(),
    stat: deps.stat ?? fsStat,
    maxFilesPerMessage: deps.maxFilesPerMessage ?? DEFAULT_MAX_FILES_PER_MESSAGE,
    maxExtractedCharsPerFile: deps.maxExtractedCharsPerFile ?? DEFAULT_MAX_EXTRACTED_CHARS_PER_FILE,
    longTextThreshold: deps.longTextThreshold ?? DEFAULT_LONG_TEXT_THRESHOLD,
  };
  return Promise.all(
    messages.map(async (message) => ({
      ...message,
      content: await normalizeContent(message.content, resolved),
    }))
  );
};
