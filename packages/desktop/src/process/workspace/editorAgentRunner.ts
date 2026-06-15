/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Editor sub-agent runner — drives one **editor surface**: read a file, ask the
 * model to rewrite it per the user's instruction, then save it back through the
 * fs bridge (so the Studio editor showing the same file reflects the change).
 *
 * Like the web agent it uses a small, provider-agnostic protocol over the user's
 * configured model (`/chat/completions`): the model is given the current file
 * content + the instruction and must reply with a single fenced JSON object —
 * either `{"tool":"write","content":"<full new file>"}` to persist a new version
 * or `{"tool":"finish","answer":"..."}` when no change is needed. Keeping it to
 * one decisive write keeps editor edits safe and observable (no partial diffs to
 * misapply) and mirrors `webAgentRunner`'s JSON-tool style.
 *
 * Every collaborator (file read/write, the chat call) is injected so the runner
 * is unit-testable without aioncore or the network.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { AgentChat } from '@process/browser/webAgentRunner';
import type {
  EditorSurfaceSpec,
  ISurfaceRunner,
  SurfacePrepared,
  SurfaceRunContext,
  SurfaceRunOutcome,
  SurfaceSpec,
} from './surfaceTypes';
import { fileTitle } from './surfaceTypes';

/** File access the editor runner needs (a narrow slice of the fs bridge). */
export type EditorFileIO = {
  /** Read a file's UTF-8 text (empty string when missing/unreadable). */
  read: (filePath: string) => Promise<string>;
  /** Write a file's UTF-8 text. Resolves when persisted. */
  write: (filePath: string, content: string) => Promise<void>;
};

/** Injected dependencies for {@link createEditorAgentRunner}. */
export type EditorAgentRunnerDeps = {
  /** The model call used for reasoning. */
  chat: AgentChat;
  /** File read/write. */
  io: EditorFileIO;
  /** Max edit rounds before the loop force-finishes. Default 4. */
  maxRounds?: number;
};

/** Default ceiling on edit rounds. */
const DEFAULT_MAX_ROUNDS = 4;

/** Max characters of file content fed into the model prompt. */
const MAX_CONTENT_CHARS = 16000;

/** The actions the editor model may request. */
type EditorAction = { tool: 'write'; content: string } | { tool: 'finish'; answer: string };

const SYSTEM_PROMPT = `You are a document-editing agent operating on ONE text file on the user's behalf.
You are given the file's current content and an instruction. Decide how to change the file.

Respond with EXACTLY ONE JSON object wrapped in a \`\`\`json code fence, and nothing else:

- {"tool":"write","content":"<the COMPLETE new file content>"}  → replace the whole file with this content
- {"tool":"finish","answer":"..."}                              → you are done; give a short summary to the user

Rules:
- When you write, output the ENTIRE file (not a diff). Preserve parts you are not changing.
- Make the smallest change that satisfies the instruction.
- After a write you receive a confirmation; then call "finish" with a short summary unless more edits are needed.
- Answer the user in the same language they used. Be concise.`;

/** Extract the first JSON object from a model reply (fenced or bare). */
const extractJson = (reply: string): string | null => {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) return fenced[1].trim();
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start !== -1 && end > start) return reply.slice(start, end + 1).trim();
  return null;
};

/** Parse a model reply into an {@link EditorAction}, or `null` when malformed. */
const parseAction = (reply: string): EditorAction | null => {
  const json = extractJson(reply);
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.tool === 'write') return typeof obj.content === 'string' ? { tool: 'write', content: obj.content } : null;
  if (obj.tool === 'finish') return { tool: 'finish', answer: typeof obj.answer === 'string' ? obj.answer : '' };
  return null;
};

/** Truncate text for prompt use. */
const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);

/**
 * Create an editor {@link ISurfaceRunner}. `prepare` resolves the file title;
 * `run` reads the file, runs the edit loop, and saves any new content.
 */
export const createEditorAgentRunner = (deps: EditorAgentRunnerDeps): ISurfaceRunner => {
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;

  const asEditor = (spec: SurfaceSpec): EditorSurfaceSpec => {
    if (spec.kind !== 'editor') throw new Error('[EditorAgentRunner] received a non-editor surface spec.');
    return spec;
  };

  return {
    prepare(spec): Promise<SurfacePrepared> {
      const editor = asEditor(spec);
      return Promise.resolve({ title: fileTitle(editor.filePath), filePath: editor.filePath });
    },

    async run(spec, _prepared, ctx: SurfaceRunContext): Promise<SurfaceRunOutcome> {
      const editor = asEditor(spec);
      let steps = 0;

      ctx.emit({ type: 'step', tool: 'read', summary: `read(${fileTitle(editor.filePath)})` });
      steps += 1;
      const original = await deps.io.read(editor.filePath);
      ctx.emit({ type: 'observation', tool: 'read', ok: true, summary: `${original.length} chars` });

      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Instruction:\n${editor.instruction}\n\nFile: ${editor.filePath}\nCurrent content:\n"""\n${truncate(original, MAX_CONTENT_CHARS)}\n"""`,
        },
      ];

      let answer = '';
      let current = original;

      for (let round = 0; round < maxRounds; round++) {
        if (ctx.signal.aborted) break;
        const reply = await deps.chat({ model: editor.model, messages, signal: ctx.signal });
        const action = parseAction(reply);
        if (!action) {
          // Treat an unparseable reply as the final answer so we never loop forever.
          answer = reply.trim();
          break;
        }

        if (action.tool === 'finish') {
          answer = action.answer;
          break;
        }

        // tool === 'write'
        ctx.emit({ type: 'step', tool: 'write', summary: `write(${fileTitle(editor.filePath)})` });
        steps += 1;
        try {
          await deps.io.write(editor.filePath, action.content);
          current = action.content;
          ctx.emit({ type: 'observation', tool: 'write', ok: true, summary: `saved ${action.content.length} chars` });
          messages.push({ role: 'assistant', content: reply });
          messages.push({
            role: 'user',
            content: 'The file was saved successfully. If the task is complete, finish with a short summary.',
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.emit({ type: 'observation', tool: 'write', ok: false, summary: message });
          messages.push({ role: 'assistant', content: reply });
          messages.push({ role: 'user', content: `The write failed: ${message}. Try again or finish.` });
        }
      }

      if (answer.length === 0) {
        answer = current === original ? 'No changes were made.' : 'The file was updated.';
      }
      return { answer, steps };
    },
  };
};
