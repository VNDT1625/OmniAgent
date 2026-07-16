/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `fileKindMeta` — presentational metadata for each Universal Editor adapter
 * kind: which `@icon-park/react` glyph and which semantic accent token to use
 * when showing a file in the Studio dashboard. Pure mapping, renderer-only.
 *
 * The kind itself comes from the shared `editorRegistry` classifier so Studio
 * and the editor never disagree about what a file is.
 */

import { Code, FilePdf, FileWord, FileExcel, FilePpt, FileZip, FileText, Music, Pic, VideoTwo } from '@icon-park/react';
import React from 'react';
import type { EditorAdapterKind } from '@renderer/pages/editor/editorRegistry';

/** An icon component from `@icon-park/react` (accepts theme/size/fill props). */
type IconParkComponent = React.ComponentType<{
  theme?: 'outline' | 'filled' | 'two-tone' | 'multi-color';
  size?: number | string;
  fill?: string | string[];
  className?: string;
}>;

/** Per-kind display metadata: the glyph + a semantic accent class for its tile. */
export type FileKindMeta = {
  Icon: IconParkComponent;
  /** Semantic text-color utility class (never a hardcoded hex). */
  accentClass: string;
  /** i18n key (under the `editor`/`studio` modules) for the human label. */
  labelKey: string;
};

/** Map every adapter kind to its tile metadata. */
export const FILE_KIND_META: Record<EditorAdapterKind, FileKindMeta> = {
  'text-code': { Icon: Code, accentClass: 'text-primary', labelKey: 'studio.kind.code' },
  docx: { Icon: FileWord, accentClass: 'text-primary', labelKey: 'studio.kind.docx' },
  spreadsheet: { Icon: FileExcel, accentClass: 'text-success', labelKey: 'studio.kind.spreadsheet' },
  slide: { Icon: FilePpt, accentClass: 'text-warning', labelKey: 'studio.kind.slide' },
  pdf: { Icon: FilePdf, accentClass: 'text-danger', labelKey: 'studio.kind.pdf' },
  image: { Icon: Pic, accentClass: 'text-success', labelKey: 'studio.kind.image' },
  media: { Icon: VideoTwo, accentClass: 'text-primary', labelKey: 'studio.kind.media' },
  'binary-inspect': { Icon: FileZip, accentClass: 'text-t-tertiary', labelKey: 'studio.kind.binary' },
  'raw-text': { Icon: FileText, accentClass: 'text-t-secondary', labelKey: 'studio.kind.raw' },
};

/** A neutral fallback for media-audio (mp3) where a music glyph reads better. */
export const AUDIO_META: FileKindMeta = { Icon: Music, accentClass: 'text-primary', labelKey: 'studio.kind.media' };

/** A plain document glyph for anything that still slips through (defensive). */
export const DEFAULT_META: FileKindMeta = {
  Icon: FileText,
  accentClass: 'text-t-secondary',
  labelKey: 'studio.kind.raw',
};
