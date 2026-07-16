/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `embed` — a custom BlockNote block that renders a Notion-style embed for a
 * pasted URL. Trusted providers (YouTube, Spotify, Vimeo, SoundCloud, Figma,
 * Google Maps, CodePen, …) render in a **sandboxed** iframe rebuilt from a safe
 * official embed URL; anything else renders as a clickable bookmark card opened
 * in the system browser. See {@link resolveEmbed} for the provider allow-list.
 *
 * Markdown round-trip: the block carries a single `url` prop. The editor
 * serialises an embed block to a bare URL on its own line (and converts a bare
 * URL line back into an embed on load) — see `markdownEmbed.ts` — so the note
 * body stays plain Markdown in `manager-data.json`.
 *
 * Renderer-only. The iframe surface is the documented non-Arco editor exception;
 * the chrome (input, buttons) uses Arco + `@icon-park/react` + i18n.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '@arco-design/web-react';
import { Components, Earth, LinkOne } from '@icon-park/react';
import { createReactBlockSpec } from '@blocknote/react';
import { openExternalUrl } from '@/renderer/utils/platform';
import { providerLabelKey, resolveEmbed } from './embedProviders';
import styles from './EmbedBlock.module.css';

/** The block type id used in the schema + markdown bridge. */
export const EMBED_BLOCK_TYPE = 'embed' as const;

/** Render the live preview (iframe or bookmark) for a resolved URL. */
const EmbedPreview: React.FC<{ url: string }> = ({ url }) => {
  const { t } = useTranslation();
  const info = resolveEmbed(url);

  const open = (): void => void openExternalUrl(url);

  if (info.kind === 'bookmark') {
    let label = url;
    try {
      label = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      /* keep raw */
    }
    return (
      <div
        role='button'
        tabIndex={0}
        className={styles.bookmark}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        }}
      >
        <span className={styles.bookmarkIcon}>
          <Earth theme='outline' size='18' />
        </span>
        <span className={styles.bookmarkBody}>
          <span className={styles.bookmarkHost}>{label}</span>
          <span className={styles.bookmarkUrl}>{url}</span>
        </span>
        <span className={styles.bookmarkOpen}>
          <LinkOne theme='outline' size='14' /> {t('manager.notes.embed.open')}
        </span>
      </div>
    );
  }

  const pad = `${(1 / info.ratio) * 100}%`;
  return (
    <div className={styles.frameWrap}>
      <div className={styles.frameRatio} style={{ paddingBottom: pad }}>
        <iframe
          className={styles.frame}
          src={info.src}
          title={t(providerLabelKey(info.provider))}
          loading='lazy'
          // Sandboxed: allow scripts/same-origin for the player to work, but
          // block top-navigation/popups so an embed can't hijack the app.
          sandbox='allow-scripts allow-same-origin allow-presentation allow-popups'
          allow='autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write'
          allowFullScreen={info.allowFullScreen}
          referrerPolicy='strict-origin-when-cross-origin'
        />
      </div>
      <div className={styles.frameBar}>
        <span className={styles.frameProvider}>{t(providerLabelKey(info.provider))}</span>
        <Button
          type='text'
          size='mini'
          icon={<LinkOne theme='outline' size='12' />}
          onClick={open}
          className={styles.frameOpen}
        >
          {t('manager.notes.embed.open')}
        </Button>
      </div>
    </div>
  );
};

/** Empty-state: prompt the user to paste a URL. */
const EmbedInput: React.FC<{ onSubmit: (url: string) => void; editable: boolean }> = ({ onSubmit, editable }) => {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const submit = () => {
    const v = value.trim();
    if (v) onSubmit(v);
  };
  return (
    <div className={styles.empty} contentEditable={false}>
      <span className={styles.emptyIcon}>
        <Components theme='outline' size='18' />
      </span>
      <Input
        value={value}
        onChange={setValue}
        disabled={!editable}
        placeholder={t('manager.notes.embed.placeholder')}
        onPressEnter={submit}
        size='small'
        className={styles.emptyInput}
      />
      <Button type='primary' size='small' onClick={submit} disabled={!editable || !value.trim()}>
        {t('manager.notes.embed.add')}
      </Button>
    </div>
  );
};

/**
 * The custom block spec. A `url` prop holds the embedded link; empty means the
 * block shows its input prompt. The block has no editable inline content.
 */
export const embedBlockSpec = createReactBlockSpec(
  {
    type: EMBED_BLOCK_TYPE,
    propSchema: {
      url: { default: '' as string },
    },
    content: 'none',
  },
  {
    render: ({ block, editor }) => {
      const url = (block.props as { url: string }).url;
      const editable = editor.isEditable;
      return (
        <div className={styles.host} contentEditable={false}>
          {url ? (
            <EmbedPreview url={url} />
          ) : (
            <EmbedInput editable={editable} onSubmit={(next) => editor.updateBlock(block, { props: { url: next } })} />
          )}
        </div>
      );
    },
  }
);
