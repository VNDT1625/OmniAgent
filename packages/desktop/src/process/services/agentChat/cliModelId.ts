/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Model-id encoding for "drive a background AI task with a CLI agent" (Claude
 * Code, Codex, Gemini CLI, Qwen Code…) instead of an API-key provider model.
 *
 * Background AI surfaces (browser web-agent, Studio, IDE, Make Video, Testing,
 * Monitor…) all identify the model the user picked by a single `model: string`.
 * For API providers that string is the model name (e.g. `claude-opus-4-8`). To
 * let the SAME field also select a CLI agent — without changing every bridge's
 * request shape — we encode a CLI choice as an opaque, namespaced id:
 *
 *     cli:<agentId>
 *     cli:<agentId>?model=<encodedModelId>
 *
 * `withCliAgent` (see {@link ./cliAgentChat}) detects this prefix and routes the
 * call through the CLI conversation driver; any other value falls through to the
 * existing provider path unchanged. Keeping the encoding in one tiny, pure
 * module means the prefix is defined exactly once and is trivially unit-testable.
 */

/** Namespace prefix that marks a model id as "run via this CLI agent". */
export const CLI_MODEL_PREFIX = 'cli:';

/** Whether a model id selects a CLI agent rather than an API-provider model. */
export const isCliModelId = (model: string | null | undefined): boolean =>
  typeof model === 'string' && model.startsWith(CLI_MODEL_PREFIX) && model.length > CLI_MODEL_PREFIX.length;

/** Build the encoded model id for a CLI agent id, optionally pinned to a CLI-native model id. */
export const makeCliModelId = (agentId: string, modelId?: string): string => {
  const trimmedModelId = modelId?.trim();
  if (!trimmedModelId) return `${CLI_MODEL_PREFIX}${agentId}`;
  return `${CLI_MODEL_PREFIX}${agentId}?model=${encodeURIComponent(trimmedModelId)}`;
};

/**
 * Decode a CLI model id into its agent id, or `null` when the value is not a
 * CLI selection. Trims whitespace so a stray space never yields a blank agent
 * id that would later fail conversation creation.
 */
export const parseCliModelId = (model: string | null | undefined): { agentId: string; modelId?: string } | null => {
  if (!isCliModelId(model)) return null;
  const raw = (model as string).slice(CLI_MODEL_PREFIX.length).trim();
  const modelParamIndex = raw.indexOf('?model=');
  const agentId = (modelParamIndex >= 0 ? raw.slice(0, modelParamIndex) : raw).trim();
  const encodedModelId = modelParamIndex >= 0 ? raw.slice(modelParamIndex + '?model='.length) : '';
  if (agentId.length === 0) return null;
  if (!encodedModelId) return { agentId };
  try {
    const modelId = decodeURIComponent(encodedModelId).trim();
    return modelId ? { agentId, modelId } : { agentId };
  } catch {
    return { agentId };
  }
};
