/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Maximum raw Office API script size accepted from an agent. */
const MAX_OFFICE_API_SCRIPT_CHARS = 8000;

const DISALLOWED_OFFICE_API_SCRIPT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'network/browser APIs', pattern: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\b/ },
  { label: 'Node.js APIs', pattern: /\b(?:require|process|Buffer|__dirname|__filename)\b/ },
  { label: 'browser globals', pattern: /\b(?:window|localStorage|sessionStorage|indexedDB|navigator)\b/ },
  { label: 'dynamic code execution', pattern: /\b(?:eval|Function)\s*\(/ },
  { label: 'dynamic imports', pattern: /\bimport\s*\(/ },
];

export type OfficeApiScriptValidation = { ok: true; code: string } | { ok: false; reason: string };

/** Keep Office API escape hatches bounded to ONLYOFFICE Document Builder code. */
export const validateOfficeApiScript = (code: string): OfficeApiScriptValidation => {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, reason: 'script is empty' };
  if (trimmed.length > MAX_OFFICE_API_SCRIPT_CHARS) {
    return { ok: false, reason: `script is too large (${trimmed.length}/${MAX_OFFICE_API_SCRIPT_CHARS} chars)` };
  }

  for (const { label, pattern } of DISALLOWED_OFFICE_API_SCRIPT_PATTERNS) {
    if (pattern.test(trimmed)) return { ok: false, reason: `${label} are not available in Office API scripts` };
  }

  return { ok: true, code: trimmed };
};
