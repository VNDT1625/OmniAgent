/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wires the monitor services for the Main process (Yêu cầu 6, Task 15.1). It
 * assembles the full auto-fix pipeline and exposes the {@link MonitorServices}
 * the bridge needs:
 *
 *   Sentry/user error
 *     → bugMonitor.capture (breadcrumbs + dedup via reportStore, criteria 6.1/6.2)
 *     → STORED ONLY (no automatic analysis) — the user must press "Fix" on a
 *       report to start the fix flow (per user requirement / criterion 6.6 spirit).
 *
 *   On user "Fix" (monitor.fix-report → fixReport):
 *     → rootCauseAnalyzer (recall known fix OR ask the provider-backed agent)
 *     → proposalStore.save (persist for recall, criterion 6.9)
 *     → patchValidationSandbox.tryPatch (isolated copy + lease, criteria 6.4/6.8)
 *     → patchGate.submit (review by default; auto-apply only low-risk, 6.5/6.6)
 *
 *   On user "Approve" (monitor.approve-patch):
 *     → patchGate.approve → patchApplier (reversible apply + rollback, 6.7)
 *
 * Nothing is analysed or patched without an explicit user action: collection is
 * passive, and BOTH the "propose a fix" step and the "apply to the app" step are
 * gated behind a button press. Everything heavy/external is constructed here
 * from the real collaborators (Sentry tap, ResourceCoordinator, provider chat,
 * app source dir).
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { app } from 'electron';
import * as path from 'node:path';
import { createBugMonitor, type IBugMonitor } from './bugMonitor';
import { createPatchGate, type IPatchGate } from './patchGate';
import { createReportStore, type IReportStore } from './reportStore';
import { createProposalStore, type IProposalStore } from './proposalStore';
import { createRootCauseAnalyzer, type IRootCauseAnalyzer } from './rootCauseAnalyzer';
import { createCodeContextProvider } from './codeContextProvider';
import { createAnalyzerAgent } from './analyzerAgent';
import { createPatchApplier } from './patchApplier';
import { createPatchValidationSandbox } from './patchValidationSandbox';
import { createSentryErrorSource } from './sentryErrorSource';
import { createReleasePublisher, type IReleasePublisher } from './releasePublisher';
import { createGitRunner, createPrOpener } from './gitRunner';
import { getResourceCoordinator } from '../resource/resourceCoordinator';
import type { IPatchSandbox } from './patchSandbox';
import type { BugReport, PatchProposal } from './monitorTypes';
import type { MonitorServices, PublishResultView } from './monitorBridge';

/** Resolve the app source root the analyzer reads + the applier/sandbox target. */
const resolveSourceRoot = (): string => app.getAppPath();

/** Resolve the directory that holds monitor state files. */
const resolveMonitorDir = (): string => path.join(app.getPath('userData'), 'monitor');

/**
 * Resolve the fork remote URL the publisher pushes fix branches to, from
 * `AIONUI_FIX_REMOTE`. Returns `undefined` when unset → the publisher stays in
 * safe "prepare branch + commit locally, do not push" mode. Never defaults to
 * the upstream `origin` (`VNDT1625/OmniAgent`).
 */
const resolveForkUrl = (): string | undefined => {
  const url = process.env.AIONUI_FIX_REMOTE?.trim();
  return url && url.length > 0 ? url : undefined;
};

/** Named git remote the publisher pushes fix branches to (added if missing). */
const FORK_REMOTE_NAME = 'tomni-agentic-fork';

/** The lazily-built monitor singletons + the full internal pipeline. */
type FullServices = MonitorServices & {
  bugMonitor: IBugMonitor;
  reportStore: IReportStore;
  proposalStore: IProposalStore;
  patchGate: IPatchGate;
  analyzer: IRootCauseAnalyzer;
  sandbox: IPatchSandbox;
  publisher: IReleasePublisher;
};

let services: FullServices | undefined;

/**
 * Build (once) and return the Main-process monitor services. Safe to call before
 * the window exists — nothing here touches the renderer.
 *
 * @returns The monitor services for the bridge + the underlying singletons.
 */
export const getMonitorServices = (): MonitorServices & { bugMonitor: IBugMonitor } => {
  if (services) return services;

  const monitorDir = resolveMonitorDir();
  const sourceRoot = resolveSourceRoot();
  const coordinator = getResourceCoordinator();

  const reportStore = createReportStore({ filePath: path.join(monitorDir, 'bug-reports.json') });
  const proposalStore = createProposalStore({ filePath: path.join(monitorDir, 'patch-proposals.json') });

  // Analysis: gather stack-referenced source within the app dir, ask the user's
  // configured model, recall a previously-accepted fix by signature (6.9).
  const analyzer = createRootCauseAnalyzer({
    store: reportStore,
    codeContext: createCodeContextProvider({ roots: [sourceRoot] }),
    agent: createAnalyzerAgent(),
    knownFixes: proposalStore,
  });

  // Validation: isolated copy of the affected files + clean-apply check, gated
  // by the ResourceCoordinator under `patchBuild`. (No command runner yet — a
  // clean apply is a conservative pass; the gate still requires human review.)
  const sandbox = createPatchValidationSandbox({
    sourceRoot,
    sandboxRoot: path.join(monitorDir, 'sandbox'),
    coordinator,
  });

  // Apply: reversible, snapshot-first. Review required by default (6.6); only
  // low-risk fixes may auto-apply if the user later opts in via policy.
  const patchGate = createPatchGate({
    applier: createPatchApplier({ targetRoot: sourceRoot, snapshotRoot: path.join(monitorDir, 'rollback') }),
    policy: { autoApplyMaxRisk: 'none' },
  });

  /** Run the analysis → validate → gate pipeline for a report ON DEMAND. */
  const runPipeline = async (report: BugReport): Promise<PatchProposal | undefined> => {
    const { proposal, fromKnownFix } = await analyzer.analyze(report);
    if (!fromKnownFix) await proposalStore.save(proposal);
    // No diff to try (model could not propose one) → return the proposal so the
    // UI can show the analysis; nothing to validate or gate.
    if (!proposal.diff || proposal.diff.trim().length === 0) return proposal;
    const sandboxResult = await sandbox.tryPatch(proposal);
    await patchGate.submit(proposal, sandboxResult);
    // Record the (now-validated) proposal id against the signature so a future
    // identical error can recall it (criterion 6.9).
    if (sandboxResult.passed) await reportStore.attachKnownFix(report.signature, proposal.id);
    return proposal;
  };

  /**
   * User-triggered fix flow (criterion 6.6 — nothing runs until the user asks).
   * Looks up the report, runs analysis → sandbox → gate, and returns the
   * resulting proposal. Throws a clear error (surfaced by the bridge) when the
   * report is unknown or no model is configured.
   */
  const fixReport = async (reportId: string): Promise<PatchProposal> => {
    const reports = await reportStore.list();
    const report = reports.find((r) => r.id === reportId);
    if (!report) throw new Error('[Monitor] Unknown report; cannot start a fix.');
    const proposal = await runPipeline(report);
    if (!proposal) throw new Error('[Monitor] Could not produce a fix proposal for this report.');
    return proposal;
  };

  // Collection is PASSIVE: capture + dedup + store only. No analysis or patching
  // happens automatically — the user must press "Fix" on a report.
  const bugMonitor = createBugMonitor({
    store: reportStore,
    sources: [createSentryErrorSource()],
  });

  // Publisher: branches + commits an APPLIED fix and (only when a fork remote is
  // configured) pushes it + opens a PR. Pushes to a dedicated fork remote, never
  // the upstream `origin`. Without `AIONUI_FIX_REMOTE` it prepares the branch
  // locally and leaves the push to the user (safest default).
  const forkUrl = resolveForkUrl();
  const gitRunner = createGitRunner(sourceRoot);
  const publisher = createReleasePublisher({
    git: gitRunner,
    prOpener: createPrOpener(sourceRoot),
    config: { targetRemote: FORK_REMOTE_NAME, baseBranch: 'main', push: Boolean(forkUrl) },
  });

  /** Ensure the fork remote exists + points at the configured fork URL. */
  const ensureForkRemote = async (url: string): Promise<void> => {
    const existing = await gitRunner.run(['remote', 'get-url', FORK_REMOTE_NAME]);
    if (existing.code !== 0) {
      await gitRunner.run(['remote', 'add', FORK_REMOTE_NAME, url]);
    } else if (existing.stdout.trim() !== url) {
      await gitRunner.run(['remote', 'set-url', FORK_REMOTE_NAME, url]);
    }
  };

  /**
   * Publish an APPLIED proposal as a fix branch (user-triggered). Only an
   * `applied` proposal may be published — the user has reviewed + applied it
   * locally first. Returns the branch + a compare/create-PR URL to open.
   */
  const publishFix = async (proposalId: string): Promise<PublishResultView> => {
    const gated = patchGate.get(proposalId);
    if (!gated) throw new Error('[Monitor] Unknown proposal; cannot publish.');
    if (gated.status !== 'applied') {
      throw new Error('[Monitor] Only an applied fix can be published. Approve & apply it first.');
    }
    if (forkUrl) await ensureForkRemote(forkUrl);
    const result = await publisher.publish(gated.proposal);
    return {
      branch: result.branch,
      pushed: result.pushed,
      compareUrl: result.prUrl ?? result.compareUrl,
      detail: result.note,
    };
  };

  services = {
    reportStore,
    proposalStore,
    patchGate,
    analyzer,
    sandbox,
    publisher,
    bugMonitor,
    reportFromUser: (input) => bugMonitor.reportFromUser(input),
    listProposals: () => proposalStore.list(),
    getPatch: (proposalId) => patchGate.get(proposalId),
    fixReport,
    publishFix,
  };
  return services;
};
