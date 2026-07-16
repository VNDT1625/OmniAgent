/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wires the agent-facing Realtime Knowledge MCP server for the Main process.
 *
 * Binds the in-process SSE host to the live RTK service singleton
 * ({@link getRtkService}). Mirrors `process/editor/officeEditorMcpWiring.ts`.
 *
 * Process boundary: Main-process (Node.js / Electron) module.
 */

import { getRtkService } from './rtkWiring';
import { startRealtimeKnowledgeMcpHost, type RealtimeKnowledgeMcpHost } from './realtimeKnowledgeMcpHost';
import type { RealtimeKnowledgeServerDeps } from '../resources/builtinMcp/realtimeKnowledgeServer';

/** Build the {@link RealtimeKnowledgeServerDeps} from the live service singleton. */
export const getRealtimeKnowledgeServerDeps = async (): Promise<RealtimeKnowledgeServerDeps> => ({
  service: await getRtkService(),
});

/** Start the in-process Realtime Knowledge MCP host bound to the service. */
export const startRealtimeKnowledge = async (): Promise<RealtimeKnowledgeMcpHost> =>
  startRealtimeKnowledgeMcpHost(await getRealtimeKnowledgeServerDeps());
