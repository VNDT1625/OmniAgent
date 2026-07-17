/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Stable source families exposed to the experimental renderer. */
export type ExperimentalTargetKind = 'builtin' | 'acp' | 'cli' | 'remote';

/** Transport-neutral permission policy selected explicitly by the user. */
export type ExperimentalPermissionMode = 'read-only' | 'workspace-write' | 'full-access';

/** Minimum agent metadata needed by the transport-neutral core. */
export type ExperimentalAgentIdentity = {
  agent_type: string;
  agent_source?: string;
};

/** Model metadata exposed without leaking provider credentials. */
export type ExperimentalCoreModel = {
  key: string;
  modelId: string;
  label: string;
  providerId?: string;
  isDefault: boolean;
};

export type ExperimentalModelCatalog = {
  models: ExperimentalCoreModel[];
  defaultModelKey?: string;
};

export type ExperimentalSessionIdentity = {
  sessionId?: string;
  targetId: string;
  workspace: string;
  modelKey?: string;
  permissionMode?: ExperimentalPermissionMode;
  surface?: string;
};

/** Build an unambiguous identity for a reusable transport session. */
export const buildExperimentalSessionKey = (identity: ExperimentalSessionIdentity): string =>
  JSON.stringify([
    identity.sessionId ?? '',
    identity.targetId,
    identity.workspace.trim(),
    identity.modelKey ?? '',
    identity.permissionMode ?? 'workspace-write',
    identity.surface ?? 'chat',
  ]);

/** A normalized response fragment, independent from aioncore wire details. */
export type NormalizedTransportMessage =
  | { type: 'delta'; text: string; mode: 'append' | 'replace' }
  | { type: 'status'; text: string }
  | { type: 'error'; text: string };

/** Map the current catalog taxonomy onto the four public core adapters. */
export const classifyExperimentalTarget = (agent: ExperimentalAgentIdentity): ExperimentalTargetKind => {
  if (agent.agent_type === 'remote') return 'remote';
  if (agent.agent_type === 'aionrs') return 'builtin';
  if (agent.agent_source === 'custom') return 'cli';
  return 'acp';
};

const textFromUnknown = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['content', 'message', 'description', 'error']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return '';
};

/** Normalize ACP handshake model metadata into the public core contract. */
export const parseExperimentalHandshakeModels = (value: unknown): ExperimentalModelCatalog => {
  if (!value || typeof value !== 'object') return { models: [] };
  const record = value as Record<string, unknown>;
  const current = typeof record.current_model_id === 'string' ? record.current_model_id : undefined;
  const available = Array.isArray(record.available_models) ? record.available_models : [];
  const seen = new Set<string>();
  const models: ExperimentalCoreModel[] = [];

  for (const item of available) {
    if (!item || typeof item !== 'object') continue;
    const model = item as Record<string, unknown>;
    const id = typeof model.id === 'string' ? model.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const labelValue = [model.name, model.label, model.display_name].find(
      (candidate) => typeof candidate === 'string' && candidate.trim()
    );
    models.push({
      key: id,
      modelId: id,
      label: typeof labelValue === 'string' ? labelValue : id,
      isDefault: id === current,
    });
  }

  return {
    models,
    defaultModelKey: current && seen.has(current) ? current : models[0]?.key,
  };
};

const nestedErrorText = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['detail', 'message', 'description', 'content']) {
    const text = record[key];
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
};

/** Extract a terminal transport failure from event or persisted tips/error shapes. */
export const extractExperimentalTerminalError = (value: unknown): string => {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const directError = nestedErrorText(record.error);
  if (directError) return directError;

  if (record.type === 'error') return nestedErrorText(record.data) || nestedErrorText(record);
  if (record.type === 'tips' && record.content && typeof record.content === 'object') {
    const content = record.content as Record<string, unknown>;
    if (content.type === 'error' || content.error) {
      return nestedErrorText(content.error) || nestedErrorText(content);
    }
  }

  for (const key of ['last_message', 'lastMessage', 'data']) {
    const nested = extractExperimentalTerminalError(record[key]);
    if (nested) return nested;
  }
  return '';
};

/** Convert a raw `message.stream` frame into the experimental core contract. */
export const normalizeTransportMessage = (message: {
  type?: unknown;
  data?: unknown;
  replace?: unknown;
}): NormalizedTransportMessage | null => {
  const type = typeof message.type === 'string' ? message.type : '';
  if (type === 'content' || type === 'text') {
    const text = textFromUnknown(message.data);
    if (!text) return null;
    const dataReplace =
      message.data && typeof message.data === 'object' && (message.data as Record<string, unknown>).replace === true;
    return { type: 'delta', text, mode: message.replace === true || dataReplace ? 'replace' : 'append' };
  }
  if (type === 'thought' || type === 'agent_status') {
    if (!message.data || typeof message.data !== 'object') {
      const text = textFromUnknown(message.data);
      return text ? { type: 'status', text } : null;
    }
    const data = message.data as Record<string, unknown>;
    const subject = typeof data.subject === 'string' ? data.subject : '';
    const description = typeof data.description === 'string' ? data.description : textFromUnknown(data);
    const text = [subject, description].filter(Boolean).join(' - ');
    return text ? { type: 'status', text } : null;
  }
  if (type === 'error') {
    return { type: 'error', text: textFromUnknown(message.data) || 'Unknown transport error.' };
  }
  return null;
};
