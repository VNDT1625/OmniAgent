/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the editor frame store — the Main-process registry of the
 * editor frames the Super agent opens (the editor counterpart of the browser
 * view manager). Pure logic, no Electron/DOM.
 */

import { describe, it, expect } from 'vitest';
import { createEditorFrameStore } from '@/process/editor/editorFrameStore';

describe('editorFrameStore', () => {
  it('opens a frame with a title derived from the file name and version 1', () => {
    const store = createEditorFrameStore({ now: () => 100 });
    const info = store.open('/work/notes.md');
    expect(info.filePath).toBe('/work/notes.md');
    expect(info.title).toBe('notes.md');
    expect(info.version).toBe(1);
    expect(store.list()).toHaveLength(1);
  });

  it('is idempotent: re-opening the same path does not duplicate', () => {
    const store = createEditorFrameStore();
    store.open('/a/b.txt');
    store.open('/a/b.txt');
    expect(store.list()).toHaveLength(1);
  });

  it('touch() bumps the version so the renderer reloads the frame', () => {
    const store = createEditorFrameStore();
    store.open('/a/b.txt');
    store.touch('/a/b.txt');
    store.touch('/a/b.txt');
    expect(store.list()[0].version).toBe(3); // 1 (open) + 2 touches
  });

  it('touch() on an unknown path is a no-op', () => {
    const store = createEditorFrameStore();
    store.touch('/missing.txt');
    expect(store.list()).toHaveLength(0);
  });

  it('close removes one frame; closeAll clears all', () => {
    const store = createEditorFrameStore();
    store.open('/a.txt');
    store.open('/b.txt');
    store.close('/a.txt');
    expect(store.list().map((f) => f.filePath)).toEqual(['/b.txt']);
    store.closeAll();
    expect(store.list()).toHaveLength(0);
  });

  it('lists frames oldest-first (stable render order)', () => {
    let t = 0;
    const store = createEditorFrameStore({ now: () => (t += 10) });
    store.open('/first.txt');
    store.open('/second.txt');
    expect(store.list().map((f) => f.filePath)).toEqual(['/first.txt', '/second.txt']);
  });

  it('handles Windows-style backslash paths for the title', () => {
    const store = createEditorFrameStore();
    const info = store.open('C:\\work\\report.docx');
    expect(info.title).toBe('report.docx');
  });
});
