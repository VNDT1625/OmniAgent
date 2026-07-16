/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExperimentalCoreModel, ExperimentalPermissionMode } from './experimentalCoreProtocol';

export type CoreAdapterProtocol = 'tomny-json-stream' | 'codex-app-server' | 'acp' | 'openclaw-gateway';

export type CoreAdapterDefinition = {
  id: string;
  name: string;
  protocol: CoreAdapterProtocol;
  candidates: string[];
  args: string[];
  detail: string;
  runnable: boolean;
};

export type DetectedCoreTarget = CoreAdapterDefinition & {
  detected: boolean;
  available: boolean;
  command?: string;
};

export type CoreAdapterEvent =
  | { type: 'delta'; text: string; mode?: 'append' | 'replace' }
  | { type: 'status'; text: string };

export type CoreRunInput = {
  sessionId: string;
  target: DetectedCoreTarget;
  prompt: string;
  workspace: string;
  modelKey?: string;
  permissionMode: ExperimentalPermissionMode;
  signal: AbortSignal;
  emit: (event: CoreAdapterEvent) => void;
  requestPermission: (request: { tool: string; detail?: string }) => Promise<boolean>;
};

export type CoreAdapter = {
  protocol: CoreAdapterProtocol;
  listModels: (target: DetectedCoreTarget, workspace?: string) => Promise<ExperimentalCoreModel[]>;
  run: (input: CoreRunInput) => Promise<void>;
  dispose: () => Promise<void>;
};

export type ExecutableResolver = (candidates: string[]) => Promise<string | null>;

/** Quote only for the diagnostic label; commands are spawned without interpolating prompts. */
export const formatSpawnLabel = (target: DetectedCoreTarget): string =>
  [target.command ?? target.candidates[0], ...target.args].filter(Boolean).join(' ');

export const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error);
};

export const emptyModels = async (): Promise<ExperimentalCoreModel[]> => [];

/** Resolve the explicit workspace selected by the user; never fall back to the app directory. */
export const requireWorkspace = (workspace: string): string => {
  const resolved = workspace.trim();
  if (!resolved) throw new Error('Select a workspace before starting the agent.');
  return resolved;
};

export const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Error('The request was cancelled.');
};
