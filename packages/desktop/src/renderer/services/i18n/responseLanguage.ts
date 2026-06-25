/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Response-language directive for chat send boxes.
 *
 * The main conversation system prompt lives in the aioncore backend, so the
 * model has no reliable signal about which language the *user* reads — it tends
 * to mirror the language of the surrounding code/files (mostly English) or its
 * own training bias. To keep replies in the language the user picked in the app
 * (the active i18n language), we append a short directive to the outgoing model
 * input — mirroring how `buildPlanningGuard` augments the message at the
 * renderer layer. The visible chat bubble keeps the raw user text; only the
 * model input carries the directive.
 *
 * SCOPE — direct-to-user chat ONLY. Apply this exclusively where the model's
 * natural-language reply is shown straight to the user (the conversation send
 * boxes). Do NOT apply it to internal / agent-to-agent or machine-consumed
 * flows — e.g. knowledge-graph / codebase-graph summarisation, keyword or
 * search-term extraction, planners, company pipeline — those must stay in the
 * source/English language (or use their own explicit `language` threading) so
 * forcing the UI language never corrupts identifiers, search terms, or
 * structured output.
 */

import i18n, { normalizeLanguageCode } from '@/renderer/services/i18n';
import { foreignLanguageRatio } from '@/renderer/services/i18n/languageDetect';

/** Endonym (native name) for each supported UI language. */
const LANGUAGE_NATIVE_NAMES: Record<string, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  'ja-JP': '日本語',
  'ko-KR': '한국어',
  'tr-TR': 'Türkçe',
  'ru-RU': 'Русский',
  'uk-UA': 'Українська',
  'vi-VN': 'Tiếng Việt',
  'en-US': 'English',
};

// Adaptive escalation thresholds (hysteresis to avoid flapping): turn the strong
// directive ON once a reply is >= ESCALATE foreign, turn it OFF once replies are
// back to <= CLEAR foreign.
const ESCALATE_RATIO = 0.45;
const CLEAR_RATIO = 0.2;

const STRICT_PREFIX = 'aionui.langStrict.';
const strictCache = new Map<string, boolean>();

const readStrict = (conversationId: string): boolean => {
  const cached = strictCache.get(conversationId);
  if (cached !== undefined) return cached;
  let value = false;
  try {
    value = typeof sessionStorage !== 'undefined' && sessionStorage.getItem(STRICT_PREFIX + conversationId) === '1';
  } catch {
    value = false;
  }
  strictCache.set(conversationId, value);
  return value;
};

const writeStrict = (conversationId: string, value: boolean): void => {
  strictCache.set(conversationId, value);
  try {
    if (typeof sessionStorage === 'undefined') return;
    if (value) sessionStorage.setItem(STRICT_PREFIX + conversationId, '1');
    else sessionStorage.removeItem(STRICT_PREFIX + conversationId);
  } catch {
    // best-effort persistence only
  }
};

/**
 * Resolve the native name of the app's active language, or `null` when it
 * cannot be mapped to a supported language.
 */
export const getResponseLanguageName = (): string | null => {
  const current = i18n.language;
  if (!current) return null;
  return LANGUAGE_NATIVE_NAMES[normalizeLanguageCode(current)] ?? null;
};

/** Whether the strong language constraint is currently armed for a conversation. */
export const isConversationLanguageStrict = (conversationId: string): boolean => readStrict(conversationId);

/**
 * Inspect a completed assistant reply and adaptively arm/disarm the strong
 * language constraint for that conversation. Called on turn completion. A reply
 * that is mostly in a different language than the app arms the strong directive
 * for subsequent turns; once replies return to the app language it disarms,
 * so the cheap tag is used by default and the heavy directive only when needed.
 */
export const noteAssistantReply = (conversationId: string, replyText: string): void => {
  if (!conversationId || !getResponseLanguageName()) return;
  const code = normalizeLanguageCode(i18n.language);
  const ratio = foreignLanguageRatio(replyText, code);
  if (ratio >= ESCALATE_RATIO) writeStrict(conversationId, true);
  else if (ratio <= CLEAR_RATIO) writeStrict(conversationId, false);
};

/**
 * Append a "reply in this language" tag to the model input. Two strengths:
 *  - default: a minimal tag (~3-8 tokens), kept tiny because it is persisted
 *    with the user message in aioncore history and re-read every turn;
 *  - strict: a stronger directive, used only when {@link noteAssistantReply}
 *    has detected the conversation drifting to another language (adaptive
 *    escalation — pay the extra tokens only when the model actually misbehaves).
 *
 * Returns the input unchanged when:
 *  - the active language cannot be resolved,
 *  - the message is empty, or
 *  - the message is a slash command (starts with `/`) — these are control
 *    commands consumed by the agent, not natural-language prompts.
 */
export const withResponseLanguageDirective = (modelInput: string, conversationId?: string): string => {
  const trimmed = modelInput.trim();
  if (trimmed.length === 0 || trimmed.startsWith('/')) return modelInput;

  const label = getResponseLanguageName();
  if (!label) return modelInput;

  if (conversationId && isConversationLanguageStrict(conversationId)) {
    return (
      `${modelInput}\n\n[IMPORTANT — language] A previous reply was not in ${label}. ` +
      `You MUST write your ENTIRE reply to the user only in ${label}. ` +
      'Keep code, identifiers, file paths and commands unchanged.'
    );
  }

  return `${modelInput}\n\n[Respond in ${label}]`;
};
