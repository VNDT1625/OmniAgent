/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Builds the script-model option list for the Make Video controls.
 *
 * The Make Video script step runs through `runAgentChatMessages`, which accepts
 * either a provider model id (an OpenAI-compatible API-key provider OR a *local*
 * server such as Ollama / LM Studio exposed as a provider) OR a `cli:<agentId>`
 * id that drives a CLI agent (Claude Code, Codex, Gemini CLI…). To surface all
 * three ("local LLM · CLI · API key") in one picker, this helper merges:
 *
 *  1. Provider models (covers API-key cloud providers and local OpenAI-
 *     compatible servers — they are configured the same way).
 *  2. CLI agents, encoded as `cli:<agentId>[:<model>]` via {@link makeCliModelId},
 *     mirroring the IDE Understand panel so behaviour stays consistent.
 *
 * Pure + dependency-injected (no hooks) so it is unit-tested directly.
 *
 * Renderer module. No Node.js APIs.
 */

import type { AcpModelInfo } from '@/common/types/platform/acpTypes';
import type { IProvider } from '@/common/config/storage';
import type { AgentMetadata } from '@/renderer/utils/model/agentTypes';
import { makeCliModelId } from '@process/services/agentChat/cliModelId';

/** Which class of backend a model option targets — used for grouping in the UI. */
export type ScriptModelKind = 'provider' | 'cli';

/** A single selectable script model. */
export type ScriptModelOption = {
  /** The opaque model id passed to the bridge (`<model>` or `cli:<id>[:<model>]`). */
  value: string;
  /** Human-readable label shown in the picker. */
  label: string;
  /** Backend class, for `Select.OptGroup` separation. */
  kind: ScriptModelKind;
};

const isAcpModelInfo = (value: unknown): value is AcpModelInfo => {
  if (!value || typeof value !== 'object') return false;
  return Array.isArray((value as { available_models?: unknown }).available_models);
};

/** Expand one CLI agent into its selectable model options (one per ACP model). */
const cliAgentOptions = (agent: AgentMetadata): ScriptModelOption[] => {
  const modelInfo = isAcpModelInfo(agent.handshake?.available_models) ? agent.handshake.available_models : null;
  if (!modelInfo || modelInfo.available_models.length === 0) {
    return [{ value: makeCliModelId(agent.id), label: agent.name, kind: 'cli' }];
  }
  return modelInfo.available_models.map((model) => ({
    value: makeCliModelId(agent.id, model.id),
    label: `${agent.name} / ${model.label || model.id}`,
    kind: 'cli',
  }));
};

/**
 * Merge provider models and available CLI agents into a de-duplicated option
 * list (providers first, then CLI agents). `getAvailableModels` is the same
 * capability-filtered accessor exposed by `useModelProviderList`.
 */
export const buildScriptModelOptions = (
  providers: IProvider[],
  getAvailableModels: (provider: IProvider) => string[],
  agents: AgentMetadata[]
): ScriptModelOption[] => {
  const seen = new Set<string>();
  const options: ScriptModelOption[] = [];

  for (const provider of providers) {
    for (const model of getAvailableModels(provider)) {
      if (seen.has(model)) continue;
      seen.add(model);
      options.push({ value: model, label: model, kind: 'provider' });
    }
  }

  for (const agent of agents) {
    if (agent.available === false || agent.enabled === false) continue;
    for (const option of cliAgentOptions(agent)) {
      if (seen.has(option.value)) continue;
      seen.add(option.value);
      options.push(option);
    }
  }

  return options;
};
