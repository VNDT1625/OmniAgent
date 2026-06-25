/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Registers every concrete editor adapter (tasks 8.4–8.9) into the
 * {@link UniversalEditor} registry. Importing this module for its side effect
 * wires the adapters; the editor frame imports it once so all kinds resolve to a
 * real component (with `'raw-text'` already provided inline as the fallback).
 *
 * Adapters are registered lazily (`React.lazy`) so their (sometimes heavy) code
 * is only loaded when a matching file is opened — honoring "tải theo nhu cầu".
 */

import React from 'react';
import { registerEditorAdapter } from '../adapterRegistry';

registerEditorAdapter(
  'text-code',
  React.lazy(() => import('./TextCodeAdapter'))
);
registerEditorAdapter(
  'docx',
  React.lazy(() => import('./DocxAdapter'))
);
registerEditorAdapter(
  'spreadsheet',
  React.lazy(() => import('./SpreadsheetAdapter'))
);
registerEditorAdapter(
  'slide',
  React.lazy(() => import('./SlideAdapter'))
);
registerEditorAdapter(
  'pdf',
  React.lazy(() => import('./PdfAdapter'))
);
registerEditorAdapter(
  'image',
  React.lazy(() => import('./ImageAdapter'))
);
registerEditorAdapter(
  'media',
  React.lazy(() => import('./MediaAdapter'))
);
registerEditorAdapter(
  'binary-inspect',
  React.lazy(() => import('./BinaryInspectAdapter'))
);
