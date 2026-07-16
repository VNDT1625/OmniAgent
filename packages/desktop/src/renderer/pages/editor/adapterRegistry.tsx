/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Universal Editor adapter contract + runtime registry (Yêu cầu 2a).
 *
 * This module is the single source of truth for:
 * - {@link EditorAdapterProps} / {@link AdapterComponent} — the contract every
 *   adapter (tasks 8.4–8.9) implements;
 * - {@link ADAPTER_CONTENT_MODE} / {@link READ_ONLY_KINDS} — per-kind metadata;
 * - the mutable component registry + {@link registerEditorAdapter} that concrete
 *   adapters plug into;
 * - {@link RawTextAdapter} — the always-available plain-text fallback (criteria
 *   2.1 / 2.9).
 *
 * It is split out from `UniversalEditor.tsx` so the adapter modules can register
 * themselves without importing the editor frame (avoiding a circular import).
 * Renderer-only.
 */

import { Button, Input } from '@arco-design/web-react';
import { Save } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { AdapterComponentRegistry, EditorAdapterKind } from './editorRegistry';
import type { EditorContentMode } from './hooks/useEditorFile';

/**
 * The props every editor adapter receives. Aligned field-for-field with the
 * surface {@link import('./hooks/useEditorFile').useEditorFile} exposes, so an
 * adapter is a thin presentational view over the shared data layer.
 */
export type EditorAdapterProps = {
  /** Absolute (or workspace-relative) path of the file being edited. */
  filePath: string;
  /** The current (possibly edited) content buffer. Base64 string in binary mode. */
  content: string;
  /** The last-saved/loaded snapshot, for diffing or "revert" affordances. */
  savedContent: string;
  /** Whether the content is decoded text or a base64 binary payload. */
  mode: EditorContentMode;
  /** True when the buffer differs from the last-saved snapshot. */
  dirty: boolean;
  /** True while the initial load / a reload is in flight. */
  loading: boolean;
  /** True while a save is in flight. */
  saving: boolean;
  /** The most recent read/write error, or `null` when healthy. */
  error: Error | null;
  /** Replace the in-memory buffer (does not persist). */
  onChange: (next: string) => void;
  /** Persist `next` (or the current buffer) to disk. */
  onSave: (next?: string) => Promise<void>;
  /** Re-read the file from disk, discarding unsaved edits. */
  reload: () => Promise<void>;
  /** When true, the adapter should present a read-only view (e.g. binary inspect). */
  readOnly?: boolean;
  /**
   * Optional workspace root the file belongs to. The IDE passes its open folder
   * so a language-aware adapter (e.g. {@link TextCodeAdapter}) can drive a real
   * language server (LSP) scoped to that root. Absent for non-IDE editor uses.
   */
  workspace?: string;
};

/** An editor adapter is any React component accepting {@link EditorAdapterProps}. */
export type AdapterComponent = React.ComponentType<EditorAdapterProps>;

/**
 * The content mode each adapter kind needs. Text-ish kinds work on decoded text;
 * image/media/binary-inspect work on base64 binary payloads. docx/spreadsheet/
 * slide/pdf use `'none'`: they open the file in the ONLYOFFICE editor BY PATH
 * (and read their lightweight fallback by path too), so the editor frame must
 * NOT eagerly read the whole file — that both wastes memory and would hit
 * aioncore's read-buffer size limit on large documents.
 */
export const ADAPTER_CONTENT_MODE: Record<EditorAdapterKind, EditorContentMode> = {
  'text-code': 'text',
  docx: 'none',
  spreadsheet: 'none',
  slide: 'none',
  pdf: 'none',
  image: 'binary',
  media: 'binary',
  'binary-inspect': 'binary',
  'raw-text': 'text',
};

/** Adapter kinds presented read-only (no manual editing — criterion 2.8). */
export const READ_ONLY_KINDS: ReadonlySet<EditorAdapterKind> = new Set<EditorAdapterKind>(['binary-inspect', 'slide']);

/**
 * Minimal, always-available plain-text adapter (criteria 2.1 / 2.9). Bound to the
 * shared buffer via {@link EditorAdapterProps.onChange}, with a Save action
 * enabled only while there are unsaved edits.
 */
export const RawTextAdapter: AdapterComponent = ({ content, dirty, saving, onChange, onSave, readOnly }) => {
  const { t } = useTranslation();
  return (
    <div className='flex flex-col h-full gap-8px'>
      <div className='flex justify-end'>
        <Button
          type='primary'
          size='small'
          icon={<Save theme='outline' size='14' />}
          loading={saving}
          disabled={readOnly || !dirty}
          onClick={() => void onSave()}
        >
          {t('editor.action.save')}
        </Button>
      </div>
      <Input.TextArea
        className='flex-1 min-h-0 font-mono text-13px'
        value={content}
        readOnly={readOnly}
        onChange={(value) => onChange(value)}
        placeholder={t('editor.rawText.placeholder')}
      />
    </div>
  );
};

/**
 * Registry mapping each adapter kind to its component, or `null` when no
 * component is registered yet (tasks 8.4–8.9 fill these in via
 * {@link registerEditorAdapter}). `'raw-text'` is always populated.
 */
const ADAPTER_COMPONENTS: AdapterComponentRegistry<AdapterComponent | null> = {
  'text-code': null,
  docx: null,
  spreadsheet: null,
  slide: null,
  pdf: null,
  image: null,
  media: null,
  'binary-inspect': null,
  'raw-text': RawTextAdapter,
};

/**
 * Register the component for an adapter kind. Tasks 8.4–8.9 call this (from the
 * `adapters/index.ts` side-effect module) to plug their adapters in without
 * modifying the editor frame.
 *
 * @param kind      The adapter kind to register a component for.
 * @param component The component (often a `React.lazy(...)` wrapper).
 */
export const registerEditorAdapter = (kind: EditorAdapterKind, component: AdapterComponent): void => {
  ADAPTER_COMPONENTS[kind] = component;
};

/** Resolve the component registered for a kind (or `null` if none yet). */
export const componentForKind = (kind: EditorAdapterKind): AdapterComponent | null => ADAPTER_COMPONENTS[kind];

/** Access the always-present raw-text fallback component. */
export const rawTextFallback = (): AdapterComponent | null => ADAPTER_COMPONENTS['raw-text'];
