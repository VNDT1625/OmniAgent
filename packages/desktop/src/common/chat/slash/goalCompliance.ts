/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Goal compliance engine (renderer-driven hard enforcement).
 *
 * Pure, deterministic decision logic. The agent is contractually required (via
 * Goal Mode steering) to end EVERY turn with a machine-readable status marker:
 *
 *   [[GOAL next=continue|done|blocked tests=pass|fail|none phase=<n>]]
 *
 * After each turn finishes, the renderer parses the marker and decides — by code,
 * not by trusting the model — what happens next:
 *  - missing marker        → force the agent to re-emit it (capped corrections),
 *  - next=continue         → auto-drive the next phase,
 *  - next=done & tests=pass → accept (goal complete),
 *  - next=done & tests≠pass → reject; the run is NOT allowed to finish,
 *  - next=blocked          → halt and surface to the user.
 *
 * This makes progression and termination code-controlled (the strongest
 * enforcement achievable without gating the agent's tool loop in the backend).
 * All auto-driving is bounded by hard caps to keep cost finite.
 */

export type GoalNext = 'continue' | 'done' | 'blocked';
export type GoalTests = 'pass' | 'fail' | 'none';

export type GoalStatus = {
  next: GoalNext;
  tests: GoalTests;
  phase?: number;
};

// Tolerant marker matcher: fields in any order, case-insensitive, optional phase.
// Example: [[GOAL next=done tests=pass phase=8]]
const MARKER_RE = /\[\[\s*GOAL\b([^\]]*)\]\]/i;
const FIELD_RE = (name: string): RegExp => new RegExp(`\\b${name}\\s*=\\s*([a-z0-9]+)`, 'i');

const NEXT_VALUES: ReadonlySet<string> = new Set<GoalNext>(['continue', 'done', 'blocked']);
const TESTS_VALUES: ReadonlySet<string> = new Set<GoalTests>(['pass', 'fail', 'none']);

/**
 * Parse the trailing GOAL status marker from an assistant message. Returns the
 * last marker found (agents may reason mid-message; the final marker is the
 * authoritative status). Returns null when no valid marker is present.
 */
export const parseGoalStatus = (text: string): GoalStatus | null => {
  if (!text) return null;
  // Find the LAST marker occurrence.
  let lastBody: string | null = null;
  const globalRe = /\[\[\s*GOAL\b([^\]]*)\]\]/gi;
  for (let match = globalRe.exec(text); match !== null; match = globalRe.exec(text)) {
    lastBody = match[1];
  }
  if (lastBody === null) {
    const single = text.match(MARKER_RE);
    if (!single) return null;
    lastBody = single[1];
  }

  const nextMatch = lastBody.match(FIELD_RE('next'));
  const testsMatch = lastBody.match(FIELD_RE('tests'));
  const phaseMatch = lastBody.match(FIELD_RE('phase'));

  const next = nextMatch?.[1]?.toLowerCase();
  if (!next || !NEXT_VALUES.has(next)) return null;

  const testsRaw = testsMatch?.[1]?.toLowerCase();
  const tests: GoalTests = testsRaw && TESTS_VALUES.has(testsRaw) ? (testsRaw as GoalTests) : 'none';

  const phaseNum = phaseMatch ? Number.parseInt(phaseMatch[1], 10) : NaN;

  return {
    next: next as GoalNext,
    tests,
    ...(Number.isFinite(phaseNum) ? { phase: phaseNum } : {}),
  };
};

export type GoalComplianceConfig = {
  /** Max total auto-driven turns (continue/correct/reject) per goal run. */
  maxAutoTurns: number;
  /** Max consecutive "missing marker" corrections before halting. */
  maxCorrections: number;
};

export const DEFAULT_GOAL_COMPLIANCE_CONFIG: GoalComplianceConfig = {
  maxAutoTurns: 40,
  maxCorrections: 3,
};

export type GoalComplianceState = {
  /** Auto-driven turns issued so far in this run. */
  autoTurns: number;
  /** Consecutive missing-marker corrections (reset when a valid marker arrives). */
  corrections: number;
};

export const createInitialComplianceState = (): GoalComplianceState => ({ autoTurns: 0, corrections: 0 });

/**
 * Independent, renderer-side evidence check: did the agent actually run a
 * test/verification tool this run? Used to reject a `done` claim that is not
 * backed by observed verification activity (closes most of the "faked marker"
 * gap without trusting the agent's self-report).
 */
const VERIFICATION_EVIDENCE_RE =
  /\b(?:bun\s+run\s+test|npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+test|vitest|jest|pytest|go\s+test|cargo\s+test|tsc\b|typecheck|type-check|oxlint|eslint|lint:fix|check-i18n|i18n:types|coverage|playwright|getdiagnostics|quick\s*test|p* run lint|bun run lint)\b/i;

export const hasVerificationEvidence = (text: string): boolean => {
  if (!text) return false;
  return VERIFICATION_EVIDENCE_RE.test(text);
};

export type GoalComplianceContext = {
  /** Whether verification tool activity (tests/typecheck/lint/...) was observed this run. */
  verificationObserved: boolean;
};

const DEFAULT_CONTEXT: GoalComplianceContext = { verificationObserved: true };

export type GoalComplianceDecision =
  | { type: 'accept' } // goal complete — stop the run
  | { type: 'continue'; prompt: string } // drive the next phase
  | { type: 'reject'; prompt: string } // claimed done but tests not passing — keep going
  | { type: 'correct'; prompt: string } // missing/invalid marker — force re-emit
  | { type: 'halt'; reason: 'blocked' | 'max-turns' | 'max-corrections' };

// Agent-facing enforcement prompts (Vietnamese, like the pipeline text). These
// are sent as the auto-driven turns; Goal Mode steering is also prepended.
const PROMPT_CORRECT = [
  'Bạn CHƯA xuất dòng trạng thái bắt buộc ở cuối lượt.',
  'MỖI lượt PHẢI kết thúc bằng đúng MỘT dòng máy đọc được: [[GOAL next=continue|done|blocked tests=pass|fail|none phase=<số pha>]].',
  'Tiếp tục đúng QUY TRÌNH BẮT BUỘC và lần này PHẢI kết thúc bằng dòng trạng thái đó.',
].join('\n');

const PROMPT_CONTINUE = [
  'Tiếp tục pha kế tiếp theo QUY TRÌNH BẮT BUỘC. KHÔNG dừng, KHÔNG hỏi lại — tự quyết hợp lý.',
  'Kết thúc lượt bằng đúng MỘT dòng: [[GOAL next=continue|done|blocked tests=pass|fail|none phase=<số pha>]].',
].join('\n');

const PROMPT_REJECT = [
  'CHƯA được coi là HOÀN THÀNH: bạn báo next=done nhưng tests chưa pass.',
  'Quay lại pha 8/9: chạy lại quick test tracker + sửa lỗi (root-cause) tới khi tests=pass.',
  'Chỉ được next=done khi mọi Definition of Done đạt VÀ tests=pass. Kết thúc lượt bằng dòng [[GOAL ...]].',
].join('\n');

const PROMPT_NEED_VERIFICATION = [
  'CHƯA chấp nhận HOÀN THÀNH: bạn báo next=done tests=pass nhưng phiên này KHÔNG thấy bằng chứng đã chạy test/verify thật (không có lệnh chạy test/tsc/lint/build...).',
  'PHẢI chạy thật cổng test (vd `bun run test`, `bunx tsc --noEmit`, lint) và/hoặc quick test, để lại log trong phiên, RỒI mới báo next=done tests=pass.',
  'Kết thúc lượt bằng dòng [[GOAL ...]].',
].join('\n');

/**
 * Decide the next enforcement action after a finished turn. Pure.
 *
 * @param status parsed marker (null when missing/invalid)
 * @param state  running compliance counters
 * @param config caps
 */
export const decideCompliance = (
  status: GoalStatus | null,
  state: GoalComplianceState,
  config: GoalComplianceConfig,
  context: GoalComplianceContext = DEFAULT_CONTEXT
): GoalComplianceDecision => {
  if (state.autoTurns >= config.maxAutoTurns) {
    return { type: 'halt', reason: 'max-turns' };
  }

  if (status === null) {
    if (state.corrections >= config.maxCorrections) {
      return { type: 'halt', reason: 'max-corrections' };
    }
    return { type: 'correct', prompt: PROMPT_CORRECT };
  }

  if (status.next === 'blocked') {
    return { type: 'halt', reason: 'blocked' };
  }

  if (status.next === 'done') {
    if (status.tests !== 'pass') {
      return { type: 'reject', prompt: PROMPT_REJECT };
    }
    // Evidence gate: a "done + tests=pass" claim is only accepted when the
    // renderer actually observed verification activity this run.
    if (!context.verificationObserved) {
      return { type: 'reject', prompt: PROMPT_NEED_VERIFICATION };
    }
    return { type: 'accept' };
  }

  // next === 'continue'
  return { type: 'continue', prompt: PROMPT_CONTINUE };
};

/** Advance counters after issuing an auto-driven turn for the given decision. */
export const advanceComplianceState = (
  state: GoalComplianceState,
  decision: GoalComplianceDecision
): GoalComplianceState => {
  switch (decision.type) {
    case 'correct':
      return { autoTurns: state.autoTurns + 1, corrections: state.corrections + 1 };
    case 'continue':
    case 'reject':
      return { autoTurns: state.autoTurns + 1, corrections: 0 };
    default:
      return state;
  }
};
