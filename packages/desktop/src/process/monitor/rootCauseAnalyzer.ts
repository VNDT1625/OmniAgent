/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `rootCauseAnalyzer` — analyses a bug report and proposes a fix (Yêu cầu 6,
 * criterion 6.3). It packages the report + the relevant source snippets and asks
 * an agent to (a) explain the root cause and (b) propose a patch (a unified diff)
 * with a human-readable explanation and a risk level.
 *
 * Before analysing, it consults the {@link IReportStore} for a KNOWN FIX of the
 * same signature (criterion 6.9): if one exists, it short-circuits and recalls
 * it instead of re-analysing. The code-context provider and the agent call are
 * injected so this module only orchestrates and stays testable without an LLM.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import * as crypto from 'node:crypto';
import type { BugReport, PatchProposal } from './monitorTypes';
import type { IReportStore } from './reportStore';

/** Supplies relevant source snippets for a report (e.g. files named in the stack). */
export type CodeContextProvider = {
  /** Return code snippets relevant to the report (path + content), best-effort. */
  gather(report: BugReport): Promise<Array<{ path: string; content: string }>>;
};

/** The raw analysis an agent returns (parsed from its response). */
export type AgentAnalysis = {
  /** Plain-language root cause. */
  rootCause: string;
  /** Explanation of the proposed fix. */
  explanation: string;
  /** Unified diff to apply on a copy of the app. */
  diff: string;
  /** Risk classification. */
  risk: 'low' | 'medium' | 'high';
};

/** The injected agent call that performs the analysis. */
export type AnalyzerAgent = {
  /** Analyse a report + code context and return a structured proposal. */
  analyze(input: { report: BugReport; code: Array<{ path: string; content: string }> }): Promise<AgentAnalysis>;
};

/** A previously-accepted proposal that can be recalled by signature (criterion 6.9). */
export type KnownFixProvider = {
  /** Look up an accepted proposal by id (e.g. from a persisted proposals store). */
  get(fixId: string): Promise<PatchProposal | undefined>;
};

/** Options for {@link createRootCauseAnalyzer}. */
export type RootCauseAnalyzerDeps = {
  /** The bug-report repository (for known-fix recall). */
  store: IReportStore;
  /** Gathers relevant source snippets. */
  codeContext: CodeContextProvider;
  /** The analysis agent. */
  agent: AnalyzerAgent;
  /** Optional recall of previously-accepted fixes by id (criterion 6.9). */
  knownFixes?: KnownFixProvider;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
};

/** Result of {@link IRootCauseAnalyzer.analyze}. */
export type AnalysisResult = {
  /** The proposal (freshly analysed or recalled). */
  proposal: PatchProposal;
  /** Whether the proposal came from a recalled known fix (criterion 6.9). */
  fromKnownFix: boolean;
};

/** Public contract of the root-cause analyzer. */
export type IRootCauseAnalyzer = {
  /** Analyse a report → propose a fix, recalling a known fix when available. */
  analyze(report: BugReport): Promise<AnalysisResult>;
};

/**
 * Create a {@link IRootCauseAnalyzer}.
 *
 * @param deps Store, code-context provider, agent, optional known-fix recall.
 * @returns An analyzer that proposes (or recalls) a patch for a report.
 */
export const createRootCauseAnalyzer = (deps: RootCauseAnalyzerDeps): IRootCauseAnalyzer => {
  const now = deps.now ?? (() => Date.now());

  const analyze: IRootCauseAnalyzer['analyze'] = async (report) => {
    // Recall a known fix for this signature first (criterion 6.9) — skip re-analysis.
    if (report.knownFixId && deps.knownFixes) {
      const recalled = await deps.knownFixes.get(report.knownFixId);
      if (recalled) return { proposal: recalled, fromKnownFix: true };
    }

    const code = await deps.codeContext.gather(report);
    const analysis = await deps.agent.analyze({ report, code });
    const proposal: PatchProposal = {
      id: crypto.randomUUID(),
      reportId: report.id,
      signature: report.signature,
      rootCause: analysis.rootCause,
      explanation: analysis.explanation,
      diff: analysis.diff,
      risk: analysis.risk,
      createdAt: now(),
    };
    return { proposal, fromKnownFix: false };
  };

  return { analyze };
};
