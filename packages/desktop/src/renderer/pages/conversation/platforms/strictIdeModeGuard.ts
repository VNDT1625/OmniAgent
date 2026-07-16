/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-side enforcement of Strict IDE Mode (Layer 2 of the hard guard).
 *
 * When Strict IDE Mode is enabled for a workspace, this intercepts every
 * `acp_permission` request the backend raises and AUTO-DENIES any tool call
 * that is not part of the built-in `ide_*` / MTUI tooling — without ever
 * showing the approval card to the user. The agent therefore cannot run its
 * own Bash/Write/Edit/Read/Glob/Grep; the only way for it to touch the repo is
 * the `ide_*` tools.
 *
 * The PURE decision lives in `@/common/chat/approval/ideToolGuard`; this module
 * only wires that decision to localStorage (the toggle), the conversation
 * workspace lookup, and the `confirmMessage` IPC call.
 *
 * Process boundary: Renderer module — uses localStorage + ipcBridge, no Node.
 */

import { ipcBridge } from '@/common';
import type { IMessageAcpPermission } from '@/common/chat/chatLib';
import {
  IDE_STRICT_MODE_PREFIX,
  evaluateStrictModePermission,
  evaluateStrictModeConfirmation,
  type GuardConfirmation,
  type GuardPermissionOption,
  type GuardToolCall,
} from '@/common/chat/approval/ideToolGuard';
import type { TChatConversation } from '@/common/config/storage';
import { getAskMode } from '@/common/types/agent/agentModes';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';

/** Read the per-workspace Strict IDE Mode toggle from localStorage. */
export const isStrictIdeModeEnabled = (rootPath: string | undefined): boolean => {
  if (!rootPath) return false;
  try {
    return localStorage.getItem(IDE_STRICT_MODE_PREFIX + rootPath) === '1';
  } catch {
    return false;
  }
};

/** Persist the per-workspace Strict IDE Mode toggle. */
export const setStrictIdeModeEnabled = (rootPath: string, enabled: boolean): void => {
  try {
    if (enabled) localStorage.setItem(IDE_STRICT_MODE_PREFIX + rootPath, '1');
    else localStorage.removeItem(IDE_STRICT_MODE_PREFIX + rootPath);
  } catch {
    /* localStorage unavailable — best effort */
  }
};

type StrictModeConversation = {
  type: TChatConversation['type'];
  extra?: { backend?: string };
};

type StrictModeSessionDeps = {
  loadConversation?: (conversationId: string) => Promise<StrictModeConversation | null>;
  persistMode?: (conversationId: string, mode: string) => Promise<boolean>;
  setMode?: (conversationId: string, mode: string) => Promise<boolean>;
};

const loadStrictModeConversation = async (conversationId: string): Promise<StrictModeConversation | null> => {
  const conversation = await getConversationOrNull(conversationId);
  if (!conversation) return null;
  return {
    type: conversation.type,
    extra: 'backend' in conversation.extra ? { backend: conversation.extra.backend } : undefined,
  };
};

const persistStrictMode = async (conversationId: string, mode: string): Promise<boolean> =>
  Boolean(
    await ipcBridge.conversation.update.invoke({
      id: conversationId,
      updates: { extra: { session_mode: mode } as TChatConversation['extra'] },
      merge_extra: true,
    })
  );

const setStrictRuntimeMode = async (conversationId: string, mode: string): Promise<boolean> => {
  await ipcBridge.acpConversation.setMode.invoke({ conversation_id: conversationId, mode });
  return true;
};

const resolveConversationBackend = (conversation: StrictModeConversation): string | undefined => {
  if (conversation.type === 'acp') return conversation.extra?.backend;
  if (conversation.type === 'aionrs' || conversation.type === 'codex') return conversation.type;
  return undefined;
};

/**
 * Force an existing IDE conversation onto an ask-before-acting mode.
 *
 * Persisting covers sessions that have not initialized yet; the runtime update
 * covers already-running sessions. Either success is enough to close the YOLO
 * bypass that would otherwise skip permission events entirely.
 */
export const enforceStrictIdeSessionMode = async (
  conversationId: string,
  deps?: StrictModeSessionDeps
): Promise<boolean> => {
  const conversation = await (deps?.loadConversation ?? loadStrictModeConversation)(conversationId).catch(
    (): null => null
  );
  if (!conversation) return false;

  const mode = getAskMode(resolveConversationBackend(conversation));
  if (!mode) return false;

  const [persisted, applied] = await Promise.all([
    (deps?.persistMode ?? persistStrictMode)(conversationId, mode).catch((): boolean => false),
    (deps?.setMode ?? setStrictRuntimeMode)(conversationId, mode).catch((): boolean => false),
  ]);
  return persisted || applied;
};

/** Resolve the workspace path backing a conversation (or undefined). */
const resolveWorkspace = async (conversation_id: string): Promise<string | undefined> => {
  const conversation = await getConversationOrNull(conversation_id).catch((): null => null);
  const extra = (conversation as { extra?: { workspace?: string } } | null)?.extra;
  return extra?.workspace;
};

/**
 * The outcome of handling a permission message under Strict IDE Mode:
 * - `denied`  → the request was auto-rejected; the caller should NOT render the
 *   approval card.
 * - `allowed` → Strict Mode is off or the tool is whitelisted; render as usual.
 */
export type StrictModeHandling = {
  denied: boolean;
  reason: string;
};

type PermissionConfirmParams = {
  confirm_key: string;
  msg_id: string;
  conversation_id: string;
  call_id: string;
};

type ConfirmFn = (params: PermissionConfirmParams) => Promise<void>;

type StopFn = (params: { conversation_id: string }) => Promise<void>;

type PermissionMode = 'manual' | 'auto';

type PermissionDeps = {
  isEnabled?: (rootPath: string | undefined) => boolean;
  resolveWorkspacePath?: (conversation_id: string) => Promise<string | undefined>;
  confirm?: ConfirmFn;
  stop?: StopFn;
  permissionMode?: PermissionMode;
};

const pickAllowOptionId = (options: ReadonlyArray<GuardPermissionOption> | undefined): string | null =>
  options?.find((option) => option.kind === 'allow_once')?.option_id ??
  options?.find((option) => option.kind === 'allow_always')?.option_id ??
  options?.find((option) => /allow|yes|approve|accept/i.test(option.name))?.option_id ??
  null;

const pickConfirmationAllow = (confirmation: GuardConfirmation): string | null => {
  const option =
    confirmation.options?.find(
      (o) => /allow|yes|approve|accept/i.test(o.label) || /allow|yes|approve|accept/i.test(String(o.value))
    ) ?? null;
  return option?.value == null ? null : String(option.value);
};

const isAutoPermissionMode = (mode: PermissionMode | undefined): boolean => mode === 'auto';

const defaultConfirm: ConfirmFn = (params) => ipcBridge.conversation.confirmMessage.invoke(params);

const defaultStop: StopFn = (params) => ipcBridge.conversation.stop.invoke(params);

const stopTurnFailClosed = async (conversationId: string, stop: StopFn, context: string): Promise<void> => {
  try {
    await stop({ conversation_id: conversationId });
  } catch (error: unknown) {
    console.error(`Strict IDE Mode failed to stop the turn after ${context}:`, error);
  }
};

// Rejecting a single native call is preferred. Stopping the turn is the fail-closed
// fallback when the backend offers no reject option or cannot record the rejection.

/**
 * Inspect an `acp_permission` message and, when Strict IDE Mode is on and the
 * tool is not an `ide_*` / MTUI tool, auto-send a reject via `confirmMessage`.
 *
 * Returns `{ denied: true }` when it auto-denied (the caller should suppress the
 * approval UI), otherwise `{ denied: false }`.
 *
 * Injectable deps keep this unit-testable without real IPC / localStorage.
 */
export const enforceStrictIdeModeOnPermission = async (
  message: IMessageAcpPermission,
  deps?: PermissionDeps
): Promise<StrictModeHandling> => {
  const content = message.content;
  const tool_call = content?.tool_call as GuardToolCall | undefined;
  const options = (content?.options as GuardPermissionOption[] | undefined) ?? [];

  const workspace = await (deps?.resolveWorkspacePath ?? resolveWorkspace)(message.conversation_id);
  const enabled = (deps?.isEnabled ?? isStrictIdeModeEnabled)(workspace);

  const decision = evaluateStrictModePermission(enabled, tool_call, options);
  const confirm = deps?.confirm ?? defaultConfirm;
  const stop = deps?.stop ?? defaultStop;
  if (!decision.deny) {
    const allowOptionId = pickAllowOptionId(options);
    // Strict Mode decides which tools are permitted; YOLO independently decides
    // whether a permitted call is approved automatically.
    if (isAutoPermissionMode(deps?.permissionMode) && allowOptionId) {
      try {
        await confirm({
          confirm_key: allowOptionId,
          msg_id: message.id,
          conversation_id: message.conversation_id,
          call_id: tool_call?.tool_call_id || message.id,
        });
      } catch (error: unknown) {
        console.error('Strict IDE Mode auto-allow failed:', error);
        await stopTurnFailClosed(message.conversation_id, stop, 'auto-allow failure');
      }
      return { denied: true, reason: `✅ ${tool_call?.title || 'IDE tool'} tự động được phép theo quyền YOLO.` };
    }
    return { denied: false, reason: decision.reason };
  }

  if (!decision.rejectOptionId) {
    await stopTurnFailClosed(message.conversation_id, stop, 'missing reject option');
    return { denied: true, reason: decision.reason };
  }

  try {
    await confirm({
      confirm_key: decision.rejectOptionId,
      msg_id: message.id,
      conversation_id: message.conversation_id,
      call_id: tool_call?.tool_call_id || message.id,
    });
  } catch (error: unknown) {
    console.error('Strict IDE Mode auto-deny failed:', error);
    await stopTurnFailClosed(message.conversation_id, stop, 'reject failure');
  }

  return { denied: true, reason: decision.reason };
};

/**
 * Confirmation-shaped (aionrs) variant of {@link enforceStrictIdeModeOnPermission}.
 * The aionrs backend re-tags `acp_permission` to a Confirmation payload, so we
 * evaluate that shape and send back the option `value` aionrs expects.
 */
export const enforceStrictIdeModeOnConfirmation = async (
  message: { id: string; conversation_id: string; content: GuardConfirmation },
  deps?: PermissionDeps
): Promise<StrictModeHandling> => {
  const confirmation = message.content;
  const workspace = await (deps?.resolveWorkspacePath ?? resolveWorkspace)(message.conversation_id);
  const enabled = (deps?.isEnabled ?? isStrictIdeModeEnabled)(workspace);

  const decision = evaluateStrictModeConfirmation(enabled, confirmation);
  const confirm = deps?.confirm ?? defaultConfirm;
  const stop = deps?.stop ?? defaultStop;
  if (!decision.deny) {
    const allowKey = pickConfirmationAllow(confirmation);
    // Strict Mode decides which tools are permitted; YOLO independently decides
    // whether a permitted call is approved automatically.
    if (isAutoPermissionMode(deps?.permissionMode) && allowKey) {
      try {
        await confirm({
          confirm_key: allowKey,
          msg_id: message.id,
          conversation_id: message.conversation_id,
          call_id: confirmation?.call_id || message.id,
        });
      } catch (error: unknown) {
        console.error('Strict IDE Mode auto-allow (confirmation) failed:', error);
        await stopTurnFailClosed(message.conversation_id, stop, 'confirmation auto-allow failure');
      }
      return {
        denied: true,
        reason: `✅ ${confirmation?.title || confirmation?.action || 'IDE tool'} tự động được phép theo quyền YOLO.`,
      };
    }
    return { denied: false, reason: decision.reason };
  }
  if (!decision.rejectKey) {
    await stopTurnFailClosed(message.conversation_id, stop, 'missing confirmation reject option');
    return { denied: true, reason: decision.reason };
  }

  try {
    await confirm({
      confirm_key: decision.rejectKey,
      msg_id: message.id,
      conversation_id: message.conversation_id,
      call_id: confirmation?.call_id || message.id,
    });
  } catch (error: unknown) {
    console.error('Strict IDE Mode auto-deny (confirmation) failed:', error);
    await stopTurnFailClosed(message.conversation_id, stop, 'confirmation reject failure');
  }

  return { denied: true, reason: decision.reason };
};
