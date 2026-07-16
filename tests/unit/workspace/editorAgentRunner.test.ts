/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/workspace/editorAgentRunner — the editor sub-agent that
 * reads a file, asks the model to rewrite it, and saves the result. Collaborators
 * (chat + file IO) are injected, so these tests use in-memory stubs and assert:
 *  - a `write` action persists the new content and the loop then finishes;
 *  - a `finish` (no write) leaves the file untouched;
 *  - prose / unparseable replies are treated as a final answer (no infinite loop);
 *  - the abort signal stops the loop.
 */

import { describe, expect, it } from 'vitest';
import { createEditorAgentRunner, type EditorFileIO } from '@/process/workspace/editorAgentRunner';
import type { AgentChat } from '@/process/browser/webAgentRunner';
import type { SurfaceRunContext } from '@/process/workspace/surfaceTypes';

/** An in-memory file store implementing the runner's narrow IO slice. */
const memoryIO = (initial: Record<string, string>): EditorFileIO & { files: Record<string, string> } => {
  const files = { ...initial };
  return {
    files,
    read: (p) => Promise.resolve(files[p] ?? ''),
    write: (p, c) => {
      files[p] = c;
      return Promise.resolve();
    },
  };
};

/** A chat that returns each queued reply in order, then repeats the last. */
const scriptedChat = (replies: string[]): AgentChat => {
  let i = 0;
  return async () => {
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return reply;
  };
};

/** Build a run context with a fresh (un-aborted) signal and a no-op emitter. */
const ctx = (signal?: AbortSignal): SurfaceRunContext => ({
  surfaceId: 's1',
  signal: signal ?? new AbortController().signal,
  emit: () => {},
});

const editorSpec = (filePath: string, instruction: string) =>
  ({ kind: 'editor', filePath, instruction, model: 'm' }) as const;

describe('editorAgentRunner', () => {
  it('writes new content then finishes', async () => {
    const io = memoryIO({ 'b.md': 'old' });
    const chat = scriptedChat([
      '```json\n{"tool":"write","content":"new content"}\n```',
      '```json\n{"tool":"finish","answer":"Updated the file."}\n```',
    ]);
    const runner = createEditorAgentRunner({ chat, io });
    const spec = editorSpec('b.md', 'replace everything');

    const prepared = await runner.prepare(spec);
    expect(prepared.filePath).toBe('b.md');

    const outcome = await runner.run(spec, prepared, ctx());
    expect(io.files['b.md']).toBe('new content');
    expect(outcome.answer).toBe('Updated the file.');
    expect(outcome.steps).toBeGreaterThanOrEqual(2); // read + write
  });

  it('leaves the file untouched when the model finishes without writing', async () => {
    const io = memoryIO({ 'b.md': 'unchanged' });
    const chat = scriptedChat(['```json\n{"tool":"finish","answer":"No change needed."}\n```']);
    const runner = createEditorAgentRunner({ chat, io });
    const spec = editorSpec('b.md', 'check it');

    const outcome = await runner.run(spec, await runner.prepare(spec), ctx());
    expect(io.files['b.md']).toBe('unchanged');
    expect(outcome.answer).toBe('No change needed.');
  });

  it('treats an unparseable reply as the final answer (no infinite loop)', async () => {
    const io = memoryIO({ 'b.md': 'x' });
    const chat = scriptedChat(['I cannot do that.']);
    const runner = createEditorAgentRunner({ chat, io });
    const spec = editorSpec('b.md', 'do something');

    const outcome = await runner.run(spec, await runner.prepare(spec), ctx());
    expect(outcome.answer).toBe('I cannot do that.');
    expect(io.files['b.md']).toBe('x');
  });

  it('stops when the abort signal fires', async () => {
    const io = memoryIO({ 'b.md': 'x' });
    const controller = new AbortController();
    controller.abort();
    // Even if the model would write, an already-aborted signal ends the loop
    // before any edit round runs.
    const chat = scriptedChat(['```json\n{"tool":"write","content":"should not be written"}\n```']);
    const runner = createEditorAgentRunner({ chat, io });
    const spec = editorSpec('b.md', 'edit');

    const outcome = await runner.run(spec, await runner.prepare(spec), ctx(controller.signal));
    expect(io.files['b.md']).toBe('x');
    expect(outcome.answer.length).toBeGreaterThan(0);
  });
});
