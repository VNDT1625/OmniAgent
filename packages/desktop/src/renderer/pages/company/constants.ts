/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CompanyRole } from '@process/company/companyOrchestrator';

/**
 * Default company id used when the user creates a company without typing an id.
 * Matches the Main-process default in `companyConfig.ts`.
 */
export const DEFAULT_COMPANY_ID = 'company';

/**
 * `localStorage` key under which the renderer remembers the set of company ids
 * the user has worked with. The company bridge addresses companies by id but
 * exposes no "list" channel, so the UI keeps its own lightweight roster here.
 */
export const KNOWN_COMPANIES_STORAGE_KEY = 'aionui.company.knownIds';

/**
 * `localStorage` key holding the user's app-level "executor strengths" guidance:
 * a free-text note on which AI/CLI/assistant is strong at what. It is reused for
 * every company the user designs (entered once, before AI generation) and fed
 * into the designer prompt so role assignments honour the user's own assessment.
 */
export const STRENGTHS_GUIDANCE_STORAGE_KEY = 'aionui.company.strengthsGuidance';

/** Upper bound on the stored guidance length (defensive against pathological input). */
export const STRENGTHS_GUIDANCE_MAX_LENGTH = 4000;

/** Characters / sequences that would let an id escape the companies directory. */
const UNSAFE_ID_PATTERN = /[/\\]|\.\./;

/**
 * Validate a company id the way the Main-process store does: non-empty and free
 * of path separators or `..`. Keeps the UI from submitting ids the bridge would
 * reject.
 */
export const isValidCompanyId = (companyId: string): boolean =>
  companyId.length > 0 && !UNSAFE_ID_PATTERN.test(companyId);

/** i18n key for a role's human label, e.g. `company.role.president`. */
export const roleLabelKey = (role: CompanyRole): string => {
  switch (role) {
    case 'president':
      return 'company.role.president';
    case 'division-head':
      return 'company.role.divisionHead';
    case 'worker':
      return 'company.role.worker';
    default:
      return 'company.role.worker';
  }
};

/** Read the remembered company ids from `localStorage` (safe + de-duplicated). */
export const loadKnownCompanies = (): string[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KNOWN_COMPANIES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids: string[] = [];
    for (const entry of parsed) {
      if (typeof entry === 'string' && isValidCompanyId(entry) && !ids.includes(entry)) {
        ids.push(entry);
      }
    }
    return ids;
  } catch {
    return [];
  }
};

/** Persist the remembered company ids to `localStorage` (best-effort). */
export const saveKnownCompanies = (ids: string[]): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KNOWN_COMPANIES_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Ignore storage failures (private mode / quota) — the roster is non-critical.
  }
};

/** Read the user's executor-strengths guidance from `localStorage` (safe). */
export const loadStrengthsGuidance = (): string => {
  if (typeof window === 'undefined') return '';
  try {
    const raw = window.localStorage.getItem(STRENGTHS_GUIDANCE_STORAGE_KEY);
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
};

/** Persist the user's executor-strengths guidance to `localStorage` (best-effort, length-capped). */
export const saveStrengthsGuidance = (guidance: string): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STRENGTHS_GUIDANCE_STORAGE_KEY, guidance.slice(0, STRENGTHS_GUIDANCE_MAX_LENGTH));
  } catch {
    // Ignore storage failures (private mode / quota) — the guidance is non-critical.
  }
};

/**
 * Company the Company page should select the next time it mounts.
 *
 * Set by the Quick Active dock (on other pages) right before it navigates to
 * `/settings/company`, then consumed once by {@link useCompanyState} on mount.
 * A plain in-memory hand-off (not persisted) — the roster already lives in
 * `localStorage`; this only steers which one starts active.
 */
let requestedActiveCompanyId: string | null = null;

/** Ask the Company page to select `companyId` the next time it mounts. */
export const requestActiveCompany = (companyId: string): void => {
  requestedActiveCompanyId = companyId;
};

/** Read and clear the pending company request (returns `null` when none). */
export const consumeRequestedActiveCompany = (): string | null => {
  const id = requestedActiveCompanyId;
  requestedActiveCompanyId = null;
  return id;
};
