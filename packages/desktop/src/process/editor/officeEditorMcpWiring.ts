/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wires the agent-facing Office-editor MCP server for the Main process.
 *
 * The single dep is the editor-tools invoker ({@link runEditorTool}), which
 * drives the renderer's live ONLYOFFICE editor over the symmetric platform
 * bridge. Mirrors `process/automation/automationMcpWiring.ts`.
 *
 * Process boundary: Main-process (Node.js / Electron) module.
 */

import { runEditorTool } from './editorToolsClient';
import { type OfficeEditorServerDeps } from '../resources/builtinMcp/officeEditorServer';
import { startOfficeEditorMcpHost, type OfficeEditorMcpHost } from './officeEditorMcpHost';

/** Build the {@link OfficeEditorServerDeps} from the editor-tools bridge client. */
export const getOfficeEditorServerDeps = (): OfficeEditorServerDeps => ({
  runTool: (filePath, action) => runEditorTool(filePath, action),
});

/** Start the in-process Office-editor MCP host bound to the bridge client. */
export const startOfficeEditor = (): Promise<OfficeEditorMcpHost> =>
  startOfficeEditorMcpHost(getOfficeEditorServerDeps());
