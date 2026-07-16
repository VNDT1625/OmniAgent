/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CoreAdapterDefinition, DetectedCoreTarget, ExecutableResolver } from './coreAdapter';

const execFileAsync = promisify(execFile);

const tomnyBinaryName = (): string => (process.platform === 'win32' ? 'tomny.exe' : 'tomny');

export const bundledTomnyCliCandidates = (): string[] => {
  const runtimeKey = `${process.platform}-${process.arch}`;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return [
    ...(resourcesPath ? [path.join(resourcesPath, 'bundled-tomny-cli', runtimeKey, tomnyBinaryName())] : []),
    path.resolve(process.cwd(), 'resources', 'bundled-tomny-cli', runtimeKey, tomnyBinaryName()),
    'tomny',
  ];
};

/**
 * Direct adapters owned by the TypeScript core. Adding a CLI is data-driven:
 * detection metadata is separate from the protocol implementation.
 */
export const CORE_ADAPTER_DEFINITIONS: CoreAdapterDefinition[] = [
  {
    id: 'tomny',
    name: 'Tomny CLI',
    protocol: 'tomny-json-stream',
    candidates: bundledTomnyCliCandidates(),
    args: ['--json-stream'],
    detail: 'Built-in Tomny agent (direct JSONL stdio)',
    runnable: true,
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    protocol: 'codex-app-server',
    candidates: ['codex'],
    args: ['app-server'],
    detail: 'OpenAI app-server (JSONL stdio)',
    runnable: true,
  },
  {
    id: 'claude',
    name: 'Claude Code',
    protocol: 'acp',
    candidates: ['claude-agent-acp'],
    args: [],
    detail: 'Claude Agent ACP',
    runnable: true,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    protocol: 'acp',
    candidates: ['opencode'],
    args: ['acp'],
    detail: 'OpenCode ACP',
    runnable: true,
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    protocol: 'acp',
    candidates: ['agent', 'cursor-agent'],
    args: ['acp'],
    detail: 'Cursor Agent ACP',
    runnable: true,
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    protocol: 'acp',
    candidates: ['hermes'],
    args: ['acp'],
    detail: 'Hermes ACP',
    runnable: true,
  },
  {
    id: 'kiro',
    name: 'Kiro CLI',
    protocol: 'acp',
    candidates: ['kiro-cli', 'kiro'],
    args: ['acp'],
    detail: 'Kiro ACP (capability verified at handshake)',
    runnable: true,
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    protocol: 'acp',
    candidates: process.platform === 'win32' ? ['agi.exe', 'agi'] : ['agi'],
    args: ['acp'],
    detail: 'Antigravity ACP',
    runnable: true,
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    protocol: 'acp',
    candidates: ['gemini'],
    args: ['--experimental-acp'],
    detail: 'Gemini CLI ACP',
    runnable: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek TUI',
    protocol: 'acp',
    candidates: ['deepseek-tui'],
    args: ['acp'],
    detail: 'DeepSeek TUI ACP',
    runnable: true,
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    protocol: 'acp',
    candidates: ['openclaw'],
    args: ['acp'],
    detail: 'OpenClaw ACP bridge backed by its configured Gateway',
    runnable: true,
  },
];

const isAdapterDefinition = (value: unknown): value is CoreAdapterDefinition => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CoreAdapterDefinition>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    ['tomny-json-stream', 'codex-app-server', 'acp', 'openclaw-gateway'].includes(candidate.protocol ?? '') &&
    Array.isArray(candidate.candidates) &&
    candidate.candidates.every((item) => typeof item === 'string') &&
    Array.isArray(candidate.args) &&
    candidate.args.every((item) => typeof item === 'string') &&
    typeof candidate.detail === 'string' &&
    typeof candidate.runnable === 'boolean'
  );
};

/**
 * Load an optional versioned adapter catalog. Existing IDs are replaced and new
 * adapters are appended, allowing CLI command changes without rebuilding Tomny Core.
 */
export const loadCoreAdapterDefinitions = async (
  catalogPath = process.env.TOMNY_CORE_ADAPTER_CATALOG
): Promise<CoreAdapterDefinition[]> => {
  if (!catalogPath) return CORE_ADAPTER_DEFINITIONS;
  const parsed: unknown = JSON.parse(await readFile(catalogPath, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.every(isAdapterDefinition)) {
    throw new Error(`Invalid Tomny Core adapter catalog: ${catalogPath}`);
  }
  const definitions = new Map(CORE_ADAPTER_DEFINITIONS.map((definition) => [definition.id, definition]));
  for (const definition of parsed) definitions.set(definition.id, definition);
  return [...definitions.values()];
};

/** Resolve the first executable without invoking aioncore or its HTTP detector. */
export const resolveExecutableOnPath: ExecutableResolver = async (candidates) => {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  const resolved = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        if (path.isAbsolute(candidate)) {
          await access(candidate);
          return candidate;
        }
        const { stdout } = await execFileAsync(probe, [candidate], { windowsHide: true, timeout: 2500 });
        const paths = stdout
          .split(/\r?\n/u)
          .map((value) => value.trim())
          .filter(Boolean);
        return (
          paths.find((value) => /\.cmd$/iu.test(value)) ??
          paths.find((value) => /\.exe$/iu.test(value) && !value.includes('WindowsApps')) ??
          paths.find((value) => /\.exe$/iu.test(value)) ??
          paths.find((value) => !/\.ps1$/iu.test(value)) ??
          null
        );
      } catch {
        return null;
      }
    })
  );
  return resolved.find((value): value is string => value !== null) ?? null;
};

export const detectCoreTargets = async (
  resolveExecutable: ExecutableResolver = resolveExecutableOnPath,
  definitions?: CoreAdapterDefinition[]
): Promise<DetectedCoreTarget[]> =>
  Promise.all(
    (definitions ?? (await loadCoreAdapterDefinitions())).map(async (definition) => {
      const command = await resolveExecutable(definition.candidates);
      return Object.assign({}, definition, {
        command: command ?? undefined,
        detected: command !== null,
        available: command !== null && definition.runnable,
      });
    })
  );
