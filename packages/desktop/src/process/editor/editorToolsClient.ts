/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `editorToolsClient` — the MAIN half of the editor-tools bridge.
 *
 * Invokes the renderer-registered provider (`renderer/pages/studio/
 * editorToolsProvider.ts`) so the Office-editor MCP server can drive the LIVE
 * ONLYOFFICE editor. The `@office-ai/platform` bridge is symmetric, so an
 * `invoke` issued here is answered by the `provider` the renderer registered.
 *
 * Calls are timeout-guarded: if no editor view is mounted (no provider
 * registered) the invoke would otherwise hang forever, so we reject fast with a
 * clear "editor not available" error the MCP tool surfaces to the model.
 *
 * Process boundary: Main-process (Node.js) module — but uses only the bridge
 * (no Electron/DOM), so it is unit-testable.
 */

import { bridge } from '@office-ai/platform';
import {
  EDITOR_TOOLS_CHANNELS,
  type EditorToolAction,
  type EditorToolRunRequest,
  type EditorToolRunResult,
} from './editorToolsBridge';

/** Typed invoker for the editor-tools run channel. */
const channel = bridge.buildProvider<EditorToolRunResult, EditorToolRunRequest>(EDITOR_TOOLS_CHANNELS.run);

/** Default timeout (ms) for a single editor action. Local edits are sub-second. */
const RUN_TIMEOUT_MS = 20_000;

/** Reject if the renderer provider does not answer in time (no editor mounted). */
const invokeWithTimeout = (req: EditorToolRunRequest, timeoutMs: number): Promise<EditorToolRunResult> =>
  new Promise<EditorToolRunResult>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        ok: false,
        reason: 'not-ready',
        error:
          'The Studio editor is not available (no editor window is open). Open the document in the Studio editor first.',
      });
    }, timeoutMs);
    channel.invoke(req).then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    );
  });

/**
 * Run one editor action against the live document for `filePath`.
 *
 * @returns The {@link EditorToolRunResult} envelope (always resolves).
 */
export const runEditorTool = (filePath: string, action: EditorToolAction): Promise<EditorToolRunResult> =>
  invokeWithTimeout({ filePath, action }, RUN_TIMEOUT_MS);
