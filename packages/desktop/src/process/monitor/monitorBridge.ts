/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Monitor IPC bridge (Yêu cầu 6, criterion 6.2) — surfaces the bug-report list,
 * patch proposals and the approval gate to the renderer. Mirrors the
 * company/browser/resource bridge pattern: renderer-safe channel-name constants
 * + typed providers built with `@office-ai/platform`, registered once by the
 * global bootstrap (Task 15.1); it does not self-wire.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import type { BugReport, GatedPatchView, ProposalView } from './monitorViewTypes';
import type { IReportStore } from './reportStore';
import type { IPatchGate, GatedPatch } from './patchGate';
import type { PatchProposal } from './monitorTypes';

/** IPC channel names for the monitor surface. Safe to import from the renderer. */
export const MONITOR_CHANNELS = {
  listReports: 'monitor.list-reports',
  listProposals: 'monitor.list-proposals',
  reportFromUser: 'monitor.report-from-user',
  fixReport: 'monitor.fix-report',
  approvePatch: 'monitor.approve-patch',
  rejectPatch: 'monitor.reject-patch',
  rollbackPatch: 'monitor.rollback-patch',
  publishFix: 'monitor.publish-fix',
} as const;

/** Request for {@link MONITOR_CHANNELS.reportFromUser}. */
export type ReportFromUserRequest = { title: string; message: string; description: string };

/** Request addressing a single patch by proposal id. */
export type PatchIdRequest = { proposalId: string };

/** Request for {@link MONITOR_CHANNELS.rejectPatch}. */
export type RejectPatchRequest = { proposalId: string; reason: string };

/** Request for {@link MONITOR_CHANNELS.fixReport} — start a fix for one report. */
export type FixReportRequest = { reportId: string };

/** Result of publishing an applied fix as a branch on the fork. */
export type PublishResultView = {
  /** The branch that was created/committed. */
  branch: string;
  /** Whether the push to the fork succeeded. */
  pushed: boolean;
  /** GitHub compare/create-PR URL to open (when the fork URL parses). */
  compareUrl?: string;
  /** Status / failure detail (e.g. push auth error), when relevant. */
  detail?: string;
};

/** Typed monitor IPC channels. Exported for Task 15.1 registration wiring. */
export const monitorChannels = {
  listReports: bridge.buildProvider<BugReport[], void>(MONITOR_CHANNELS.listReports),
  listProposals: bridge.buildProvider<ProposalView[], void>(MONITOR_CHANNELS.listProposals),
  reportFromUser: bridge.buildProvider<BugReport, ReportFromUserRequest>(MONITOR_CHANNELS.reportFromUser),
  fixReport: bridge.buildProvider<ProposalView, FixReportRequest>(MONITOR_CHANNELS.fixReport),
  approvePatch: bridge.buildProvider<GatedPatchView, PatchIdRequest>(MONITOR_CHANNELS.approvePatch),
  rejectPatch: bridge.buildProvider<GatedPatchView, RejectPatchRequest>(MONITOR_CHANNELS.rejectPatch),
  rollbackPatch: bridge.buildProvider<GatedPatchView, PatchIdRequest>(MONITOR_CHANNELS.rollbackPatch),
  publishFix: bridge.buildProvider<PublishResultView, PatchIdRequest>(MONITOR_CHANNELS.publishFix),
};

/** The Main-process monitor services the bridge operates on. */
export type MonitorServices = {
  /** Bug-report repository. */
  reportStore: IReportStore;
  /** Patch approval gate. */
  patchGate: IPatchGate;
  /** Files a user bug report (delegates to bugMonitor in production). */
  reportFromUser: (input: ReportFromUserRequest) => Promise<BugReport>;
  /** List persisted patch proposals (newest first), with their gate status. */
  listProposals: () => Promise<PatchProposal[]>;
  /** Look up the gate state for a proposal, if it has reached the gate. */
  getPatch: (proposalId: string) => GatedPatch | undefined;
  /**
   * Start the analysis → validate → gate flow for ONE report, on user demand
   * (criterion 6.6). Returns the produced proposal. Nothing runs automatically.
   */
  fixReport: (reportId: string) => Promise<PatchProposal>;
  /**
   * Publish an APPLIED fix as a new branch on the user's fork + return a
   * compare/create-PR URL. User-triggered; only applied proposals are eligible.
   */
  publishFix: (proposalId: string) => Promise<PublishResultView>;
};

/** Options for {@link registerMonitorBridge}. */
export type RegisterMonitorBridgeOptions = {
  /** The monitor services to wire. */
  services: MonitorServices;
};

/** Project a tracked gate patch onto its renderer-facing view. */
const toGateView = (gated: {
  proposal: { id: string; risk: string; explanation: string };
  status: string;
  rejectedReason?: string;
}): GatedPatchView => ({
  proposalId: gated.proposal.id,
  risk: gated.proposal.risk,
  explanation: gated.proposal.explanation,
  status: gated.status,
  rejectedReason: gated.rejectedReason,
});

/** Project a persisted proposal (+ its current gate status) onto a view row. */
const toProposalView = (proposal: PatchProposal, gated: GatedPatch | undefined): ProposalView => ({
  proposalId: proposal.id,
  reportId: proposal.reportId,
  signature: proposal.signature,
  rootCause: proposal.rootCause,
  explanation: proposal.explanation,
  risk: proposal.risk,
  createdAt: proposal.createdAt,
  status: gated?.status ?? 'proposed',
  rejectedReason: gated?.rejectedReason,
});

/**
 * Register the monitor IPC handlers. Intended to be invoked once during
 * Main-process bootstrap (Task 15.1).
 *
 * @param options The monitor services to wire. See {@link RegisterMonitorBridgeOptions}.
 */
export function registerMonitorBridge(options: RegisterMonitorBridgeOptions): void {
  const { reportStore, patchGate, reportFromUser, listProposals, getPatch, fixReport, publishFix } = options.services;

  monitorChannels.listReports.provider(() => reportStore.list());
  monitorChannels.reportFromUser.provider((req) => reportFromUser(req));

  monitorChannels.listProposals.provider(async () => {
    const proposals = await listProposals();
    return proposals.map((p) => toProposalView(p, getPatch(p.id)));
  });

  monitorChannels.fixReport.provider(async ({ reportId }) => {
    const proposal = await fixReport(reportId);
    return toProposalView(proposal, getPatch(proposal.id));
  });

  monitorChannels.publishFix.provider(({ proposalId }) => publishFix(proposalId));

  monitorChannels.approvePatch.provider(async ({ proposalId }) => {
    const gated = await patchGate.approve(proposalId);
    return toGateView(gated);
  });
  monitorChannels.rejectPatch.provider(async ({ proposalId, reason }) => {
    const gated = await patchGate.reject(proposalId, reason);
    return toGateView(gated);
  });
  monitorChannels.rollbackPatch.provider(async ({ proposalId }) => {
    const gated = await patchGate.rollback(proposalId);
    return toGateView(gated);
  });
}
