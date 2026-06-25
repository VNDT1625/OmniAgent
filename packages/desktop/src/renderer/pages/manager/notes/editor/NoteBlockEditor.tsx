/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `NoteBlockEditor` — a Notion-style block editor for note bodies, powered by
 * BlockNote (MPL-2.0). This is the ONE place in the app that renders a non-Arco
 * editor surface — a deliberate, documented exception (see
 * `.kiro/steering/manager-editor-exception.md`): a true block editor (slash
 * commands, drag handles, tables, image/video/embed blocks) cannot be
 * reasonably reproduced with Arco primitives, and it is the core of the
 * "reading page like Notion" the user asked for.
 *
 * Contract with the rest of Manager is unchanged: the body is stored as
 * **Markdown** in `manager-data.json`. On mount we parse the incoming Markdown
 * into blocks; on edit we serialise blocks back to Markdown (lossy for a few
 * exotic blocks, which is acceptable for note bodies) and report it upward via
 * a debounced `onChange`, so the existing save flow keeps working.
 *
 * Theme + accent follow the app: the wrapper maps BlockNote's CSS variables onto
 * the app's theme tokens and the Manager `--mgr-accent` (see the CSS module).
 *
 * Renderer-only. No Node.js APIs.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BlockNoteSchema, defaultBlockSpecs, filterSuggestionItems, insertOrUpdateBlock } from '@blocknote/core';
import { useCreateBlockNote, SuggestionMenuController, getDefaultReactSlashMenuItems } from '@blocknote/react';
import type { DefaultReactSuggestionItem } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
// NOTE: we intentionally do NOT import '@blocknote/core/fonts/inter.css' — that
// bundled Inter subset renders Vietnamese diacritics poorly. The editor inherits
// the app/Manager font instead (`--bn-font-family: inherit` in the CSS module),
// which uses a Vietnamese-capable system stack.
import '@blocknote/mantine/style.css';
import { useTranslation } from 'react-i18next';
import { Components } from '@icon-park/react';
import { EMBED_BLOCK_TYPE, embedBlockSpec } from './embed/EmbedBlock';
import { collectEmbedUrls, ensureEmbedUrlsInMarkdown, markdownToEmbedBlocks } from './embed/markdownEmbed';
import styles from './NoteBlockEditor.module.css';

type Props = {
  /** Initial Markdown body. */
  value: string;
  /** Reports the latest Markdown body (debounced). */
  onChange: (markdown: string) => void;
  /** Whether editing is allowed (false = read-only reading view). */
  editable?: boolean;
  /** Placeholder shown when empty. */
  placeholder?: string;
};

/** A schema using the default blocks + our custom `embed` block. */
const schema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, [EMBED_BLOCK_TYPE]: embedBlockSpec },
});

type EditorType = typeof schema.BlockNoteEditor;

/** Resolve the app's current light/dark mode from the `data-theme` attribute. */
const resolveScheme = (): 'light' | 'dark' => {
  if (typeof document === 'undefined') return 'light';
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
};

/**
 * Track the app theme so the BlockNote surface follows light/dark with the rest
 * of the workspace (it used to be pinned to `light`). Mirrors the observer in
 * `TerminalView`: watch the `data-theme` attribute + the OS media query.
 */
const useEditorScheme = (): 'light' | 'dark' => {
  const [scheme, setScheme] = useState<'light' | 'dark'>(resolveScheme);
  useEffect(() => {
    const apply = () => setScheme(resolveScheme());
    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    let mq: MediaQueryList | null = null;
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', apply);
    }
    return () => {
      mo.disconnect();
      mq?.removeEventListener('change', apply);
    };
  }, []);
  return scheme;
};

const NoteBlockEditor: React.FC<Props> = ({ value, onChange, editable = true, placeholder }) => {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const scheme = useEditorScheme();
  const debounceRef = useRef<number | null>(null);
  // Keep the latest onChange without re-creating the editor.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // useCreateBlockNote is a hook; call it directly at the top level.
  const bn = useCreateBlockNote({ schema, initialContent: undefined });

  // Parse the incoming Markdown into blocks once the editor exists. Bare-URL
  // lines become embed blocks (Notion-style auto-embed) via the markdown bridge.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const parsed = await bn.tryParseMarkdownToBlocks(value || '');
        const blocks = markdownToEmbedBlocks(parsed as unknown as Parameters<typeof markdownToEmbedBlocks>[0]);
        if (!alive) return;
        if (blocks.length > 0) {
          bn.replaceBlocks(bn.document, blocks as unknown as Parameters<typeof bn.replaceBlocks>[1]);
        }
      } catch {
        /* leave empty on parse failure */
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
    // Only re-parse when the note identity changes (value is the seed). We
    // intentionally exclude `value` from deps after first mount to avoid
    // clobbering the user's in-progress edits; callers remount per note via key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bn]);

  const handleChange = () => {
    if (!ready) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void (async () => {
        const md = await bn.blocksToMarkdownLossy(bn.document);
        // The lossy serialiser drops our custom embed blocks; re-insert their
        // URLs as bare-URL lines so they persist + auto-embed on next load.
        const urls = collectEmbedUrls(bn.document as unknown as Parameters<typeof collectEmbedUrls>[0]);
        onChangeRef.current(ensureEmbedUrlsInMarkdown(md, urls));
      })();
    }, 400);
  };

  // Slash-menu item: "/embed" inserts an empty embed block (prompts for a URL).
  const embedSlashItem = useMemo(
    (): DefaultReactSuggestionItem => ({
      title: t('manager.notes.embed.slashTitle'),
      subtext: t('manager.notes.embed.slashSubtext'),
      aliases: ['embed', 'youtube', 'spotify', 'video', 'iframe', 'nhúng', 'nhung'],
      group: t('manager.notes.embed.slashGroup'),
      icon: <Components theme='outline' size='18' />,
      onItemClick: () => {
        insertOrUpdateBlock(bn as unknown as EditorType, { type: EMBED_BLOCK_TYPE, props: { url: '' } });
      },
    }),
    [bn, t]
  );

  const getSlashItems = async (query: string): Promise<DefaultReactSuggestionItem[]> =>
    filterSuggestionItems([...getDefaultReactSlashMenuItems(bn), embedSlashItem], query);

  useEffect(
    () => () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    },
    []
  );

  return (
    <div className={styles.host}>
      <BlockNoteView editor={bn} editable={editable} theme={scheme} slashMenu={false} onChange={handleChange}>
        {/* Custom slash menu — default items plus our Embed block. */}
        <SuggestionMenuController triggerCharacter='/' getItems={getSlashItems} />
      </BlockNoteView>
      {placeholder && !value && !ready ? null : null}
    </div>
  );
};

export default NoteBlockEditor;
