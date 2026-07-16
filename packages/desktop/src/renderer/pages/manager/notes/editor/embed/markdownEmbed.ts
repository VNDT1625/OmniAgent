/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Markdown round-trip helpers for the custom `embed` block.
 *
 * The note body is stored as plain Markdown, but BlockNote's markdown
 * serialiser doesn't know our custom block. To keep embeds persistent we use a
 * convention that is itself valid, human-readable Markdown:
 *
 *   an embed === a line containing ONLY a bare URL.
 *
 * - {@link embedBlocksToMarkdown} replaces serialised embed blocks (which the
 *   lossy serialiser renders as empty/placeholder lines) with their bare URL.
 * - {@link markdownToEmbedBlocks} scans freshly-parsed blocks and turns any
 *   paragraph whose sole content is a bare URL into an `embed` block.
 *
 * This means: paste a YouTube link on its own line → it becomes an embed on the
 * next load, exactly like Notion's auto-embed. Pure + renderer-safe (no DOM).
 */

import { EMBED_BLOCK_TYPE } from './EmbedBlock';

/** Minimal shape of a BlockNote block we care about (avoids tight coupling). */
type LooseBlock = {
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: unknown;
};

/** A line that is ONLY a URL (optionally wrapped in <…> or as a bare link). */
const BARE_URL_LINE = /^<?(https?:\/\/[^\s<>]+)>?$/;

/** Extract a bare URL from a single trimmed line, or `null`. */
export const bareUrlOf = (line: string): string | null => {
  const m = line.trim().match(BARE_URL_LINE);
  return m ? m[1] : null;
};

/** Read plain text out of a BlockNote paragraph's inline content array. */
const paragraphText = (block: LooseBlock): string => {
  if (!Array.isArray(block.content)) return '';
  return block.content
    .map((node) => {
      if (typeof node === 'string') return node;
      if (node && typeof node === 'object' && 'type' in node && (node as { type: string }).type === 'link') {
        // A markdown autolink/link node — use its href so `[x](url)` and bare
        // links both resolve to the URL.
        const href = (node as { href?: string }).href;
        return typeof href === 'string' ? href : '';
      }
      if (node && typeof node === 'object' && 'text' in node) return String((node as { text: unknown }).text ?? '');
      return '';
    })
    .join('')
    .trim();
};

/**
 * Convert freshly-parsed markdown blocks: any paragraph that is just a bare URL
 * becomes an `embed` block. Returns a new array (input not mutated). Generic
 * over the block type to stay decoupled from BlockNote's heavy generics.
 */
export const markdownToEmbedBlocks = <T extends LooseBlock>(blocks: T[]): T[] =>
  blocks.map((block) => {
    if (block.type !== 'paragraph') return block;
    const text = paragraphText(block);
    const url = bareUrlOf(text);
    if (!url) return block;
    return { type: EMBED_BLOCK_TYPE, props: { url } } as unknown as T;
  });

/**
 * Post-process serialised markdown so embed blocks survive as bare URLs.
 *
 * BlockNote serialises an unknown/custom block to an empty or placeholder line.
 * We can't see block boundaries in the final string reliably, so instead we
 * derive the embed URLs from the live document (`urls`, in document order) and
 * splice them in: each run of blank line(s) produced where an embed sat is
 * replaced by the next embed URL. To stay robust we simply append any embed
 * URLs that aren't already present as their own line.
 */
export const ensureEmbedUrlsInMarkdown = (markdown: string, urls: string[]): string => {
  if (urls.length === 0) return markdown;
  const present = new Set(
    markdown
      .split('\n')
      .map((l) => bareUrlOf(l))
      .filter((u): u is string => u !== null)
  );
  const missing = urls.filter((u) => !present.has(u));
  if (missing.length === 0) return markdown;
  const trimmed = markdown.replace(/\s+$/, '');
  const block = missing.join('\n\n');
  return trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`;
};

/** Collect embed URLs from a live document, in order. */
export const collectEmbedUrls = <T extends LooseBlock>(blocks: T[]): string[] => {
  const urls: string[] = [];
  for (const b of blocks) {
    if (b.type === EMBED_BLOCK_TYPE) {
      const url = (b.props as { url?: unknown } | undefined)?.url;
      if (typeof url === 'string' && url.trim()) urls.push(url.trim());
    }
  }
  return urls;
};
