/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in Music MCP server — the **Agent plane** for the Music Studio.
 *
 * While the renderer page (`renderer/pages/music/`) lets the *user* make music,
 * this server lets an *AI agent* do the same through MCP tool calls, against the
 * SAME headless engine (`@aionui/music-core`) the UI uses (single source of
 * truth). The agent loads a project, drives engine commands, and — crucially —
 * can *listen* to audio (pitch/key/tempo analysis) so it behaves like a producer
 * who actually heard the material, not one guessing from metadata.
 *
 * ## Design mirrors automationMcpServer.ts
 *
 * - Factory `createMusicServer(deps)` — injected deps keep the server pure and
 *   testable without a live backend.
 * - `McpServer` from the MCP SDK; zod schemas per tool; text/json result helpers.
 * - Tool names follow `music_*` snake_case (matches `^[a-zA-Z0-9_-]+$`).
 *
 * The heavy lifting lives in music-core's `dispatchTool`: this server is a thin
 * MCP adapter that loads a project, maps a tool call onto `dispatchTool`, and
 * persists the result.
 *
 * Process boundary: Main-process (Node.js / Electron) module — no DOM APIs.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TOOL_DEFS, dispatchTool, type Project, type ToolAudio } from '@aionui/music-core';

/** Canonical MCP server name for the built-in Music server. */
export const BUILTIN_MUSIC_NAME = 'aionui-music';

/**
 * The slice of the Music service this MCP server needs. The host wires the real
 * project store + audio loader; tests pass fakes.
 */
export type MusicServerDeps = {
  /** Load the project the agent is currently working on. */
  loadProject: () => Promise<Project>;
  /** Persist a project after a mutating tool call. */
  saveProject: (project: Project) => Promise<void>;
  /**
   * Resolve reference audio for "listen" tools as decoded mono PCM. Returns
   * undefined when no reference audio is available (the tool then reports it).
   */
  loadAudio?: (ref?: string) => Promise<ToolAudio | undefined>;
};

const textResult = (
  text: string,
  isError = false
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } => ({
  content: [{ type: 'text' as const, text }],
  ...(isError ? { isError: true } : {}),
});

const jsonResult = (value: unknown) => textResult(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Tools that need reference audio (the agent's "ears"). */
const AUDIO_TOOLS = new Set(['listen', 'match_tempo_to_audio', 'comp_progression_in_heard_key']);

/**
 * Build the Music {@link McpServer} bound to the injected deps. Every engine
 * tool from music-core's catalog is exposed as `music_<name>`; each one loads
 * the current project, runs `dispatchTool`, persists on success, and returns
 * the result message + data.
 */
export const createMusicServer = (deps: MusicServerDeps): McpServer => {
  const server = new McpServer({ name: BUILTIN_MUSIC_NAME, version: '1.0.0' });

  // A discovery tool so the agent can inspect the project without mutating it.
  server.tool(
    'music_get_project',
    `Get the current music project: name, tempo, time signature, and a compact track list
(id, name, type, clip count). Call this first to discover track/clip ids before editing.`,
    {},
    async () => {
      try {
        const project = await deps.loadProject();
        return jsonResult({
          name: project.name,
          tempo: project.tempo,
          timeSignature: project.timeSignature,
          tracks: project.tracks.map((t) => ({ id: t.id, name: t.name, type: t.type, clips: t.clips.length })),
        });
      } catch (error) {
        return textResult(`Error loading project: ${describeError(error)}`, true);
      }
    }
  );

  // Map every music-core tool onto an MCP tool. Args are passed as a single
  // JSON string to keep the schema simple and avoid per-tool zod duplication;
  // music-core's dispatchTool validates each field and returns ok:false on bad
  // input rather than throwing.
  for (const def of TOOL_DEFS) {
    const paramHint = def.params
      .map((p) => `- ${p.name} (${p.type}${p.required ? ', required' : ''}): ${p.description}`)
      .join('\n');
    const needsAudio = AUDIO_TOOLS.has(def.name);

    server.tool(
      `music_${def.name}`,
      `${def.description}\n\nArguments (pass as JSON object in "args"):\n${paramHint || '- (none)'}${needsAudio ? "\n\nThis tool listens to reference audio (the project's loaded audio)." : ''}`,
      {
        args: z.string().optional().describe('JSON object of the tool arguments listed above. Omit or "{}" when none.'),
      },
      async ({ args }) => {
        // Parse args JSON (default empty object).
        let parsed: Record<string, unknown> = {};
        if (args && args.trim().length > 0) {
          try {
            const raw: unknown = JSON.parse(args);
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
              return textResult('Invalid args: expected a JSON object.', true);
            }
            parsed = raw as Record<string, unknown>;
          } catch (parseError) {
            return textResult(`Invalid args JSON: ${describeError(parseError)}`, true);
          }
        }

        try {
          const project = await deps.loadProject();
          const audio = needsAudio && deps.loadAudio ? await deps.loadAudio() : undefined;
          const result = dispatchTool(def.name, parsed, { project, audio });

          if (!result.ok) return textResult(result.message, true);
          if (result.project) await deps.saveProject(result.project);

          return jsonResult({ message: result.message, data: result.data ?? null });
        } catch (error) {
          return textResult(`Error running ${def.name}: ${describeError(error)}`, true);
        }
      }
    );
  }

  return server;
};
