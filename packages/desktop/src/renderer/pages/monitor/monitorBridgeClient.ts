/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the Monitor surface (Yêu cầu 6). Rebuilds typed
 * invokers from the channel-name strings (no Node-only import) and wraps each
 * call with a timeout so an unwired Main-process bridge (Task 15.1) rejects with
 * a clear error instead of hanging.
 */

import { bridge } from '@office-ai/platform';

/** IPC channel names for the monitor surface (renderer-safe contract). */
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

/** A bug report row for the UI. */
export type MonitorReport = {
  id: string;
  source: string;
  signature: string;
  title: string;
  message: string;
  occurrences: number;
  firstSeen: number;
  lastSeen: number;
  knownFixId?: string;
};

/** A patch view for the UI. */
export type MonitorPatch = {
  proposalId: string;
  risk: string;
  explanation: string;
  status: string;
  rejectedReason?: string;
};

/** A persisted patch proposal row for the UI (mirrors monitorViewTypes.ProposalView). */
export type MonitorProposal = {
  proposalId: string;
  reportId: string;
  signature: string;
  rootCause: string;
  explanation: string;
  risk: string;
  createdAt: number;
  status: string;
  rejectedReason?: string;
};

/** Result of publishing an applied fix as a branch (mirrors monitorBridge.PublishResultView). */
export type MonitorPublishResult = {
  branch: string;
  pushed: boolean;
  compareUrl?: string;
  detail?: string;
};

const CALL_TIMEOUT_MS = 8000;

const listReportsProvider = bridge.buildProvider<MonitorReport[], void>(MONITOR_CHANNELS.listReports);
const listProposalsProvider = bridge.buildProvider<MonitorProposal[], void>(MONITOR_CHANNELS.listProposals);
const fixReportProvider = bridge.buildProvider<MonitorProposal, { reportId: string }>(MONITOR_CHANNELS.fixReport);
const publishFixProvider = bridge.buildProvider<MonitorPublishResult, { proposalId: string }>(
  MONITOR_CHANNELS.publishFix
);
const approvePatchProvider = bridge.buildProvider<MonitorPatch, { proposalId: string }>(MONITOR_CHANNELS.approvePatch);
const rejectPatchProvider = bridge.buildProvider<MonitorPatch, { proposalId: string; reason: string }>(
  MONITOR_CHANNELS.rejectPatch
);
const rollbackPatchProvider = bridge.buildProvider<MonitorPatch, { proposalId: string }>(
  MONITOR_CHANNELS.rollbackPatch
);

const withTimeout = <T>(p: Promise<T>, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`Monitor bridge "${label}" is not available yet.`)), CALL_TIMEOUT_MS)
    ),
  ]);

/** The renderer-facing Monitor client. */
export const monitorClient = {
  /** List all bug reports (newest first). */
  listReports: (): Promise<MonitorReport[]> => withTimeout(listReportsProvider.invoke(), 'listReports'),
  /** List all patch proposals (newest first) with their gate status. */
  listProposals: (): Promise<MonitorProposal[]> => withTimeout(listProposalsProvider.invoke(), 'listProposals'),
  /** Start the fix flow for a report (analyse → sandbox → gate). User-triggered. */
  fixReport: (reportId: string): Promise<MonitorProposal> =>
    Promise.race([
      fixReportProvider.invoke({ reportId }),
      new Promise<MonitorProposal>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Monitor bridge "fixReport" timed out.')), 180000)
      ),
    ]),
  /** Approve & apply a proposal (snapshots a rollback point first). */
  approvePatch: (proposalId: string): Promise<MonitorPatch> =>
    withTimeout(approvePatchProvider.invoke({ proposalId }), 'approvePatch'),
  /** Reject a proposal; the main app is never touched. */
  rejectPatch: (proposalId: string, reason: string): Promise<MonitorPatch> =>
    withTimeout(rejectPatchProvider.invoke({ proposalId, reason }), 'rejectPatch'),
  /** Roll back a previously-applied proposal. */
  rollbackPatch: (proposalId: string): Promise<MonitorPatch> =>
    withTimeout(rollbackPatchProvider.invoke({ proposalId }), 'rollbackPatch'),
  /** Publish an applied fix as a branch on the fork (push + return compare URL). */
  publishFix: (proposalId: string): Promise<MonitorPublishResult> =>
    Promise.race([
      publishFixProvider.invoke({ proposalId }),
      new Promise<MonitorPublishResult>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Monitor bridge "publishFix" timed out.')), 120000)
      ),
    ]),
};
