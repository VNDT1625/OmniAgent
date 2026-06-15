/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useMonitorState` — loads the bug-report list + the patch-proposal list via
 * the monitor client and exposes the approval-gate actions (approve / reject /
 * roll back), degrading gracefully to a friendly "unavailable" state when the
 * Main-process bridge is not reachable. Renderer-only.
 *
 * After any gate action it reloads the proposals so the UI reflects the new gate
 * status (applied / rejected / rolled-back) without a manual refresh.
 */

import { Message } from '@arco-design/web-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { monitorClient, type MonitorProposal, type MonitorReport } from './monitorBridgeClient';

/** Status of an async load. */
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

/** The state surface returned by {@link useMonitorState}. */
export type MonitorState = {
  /** All known bug reports (newest first). */
  reports: MonitorReport[];
  /** All known patch proposals (newest first). */
  proposals: MonitorProposal[];
  /** Status of the combined load. */
  status: LoadStatus;
  /** Report or proposal id with an action currently in flight, if any. */
  busyId?: string;
  /** Reload reports + proposals. */
  refresh: () => void;
  /** Start the fix flow for a report (analyse → sandbox → gate), then refresh. */
  fix: (reportId: string) => void;
  /** Approve & apply a proposal, then refresh. */
  approve: (proposalId: string) => void;
  /** Reject a proposal, then refresh. */
  reject: (proposalId: string) => void;
  /** Roll back an applied proposal, then refresh. */
  rollback: (proposalId: string) => void;
  /** Publish an applied fix as a branch on the fork; opens the compare URL. */
  publish: (proposalId: string) => void;
};

/** Manage the monitor page state against the (possibly-unwired) monitor client. */
export const useMonitorState = (active: boolean): MonitorState => {
  const { t } = useTranslation();
  const [reports, setReports] = useState<MonitorReport[]>([]);
  const [proposals, setProposals] = useState<MonitorProposal[]>([]);
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [busyId, setBusyId] = useState<string | undefined>(undefined);

  const refresh = useCallback(() => {
    setStatus('loading');
    Promise.all([monitorClient.listReports(), monitorClient.listProposals().catch(() => [] as MonitorProposal[])])
      .then(([reportList, proposalList]) => {
        setReports(reportList);
        setProposals(proposalList);
        setStatus('ready');
      })
      .catch(() => {
        setReports([]);
        setProposals([]);
        setStatus('unavailable');
      });
  }, []);

  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);

  /** Run a gate action, surface a toast, and reload on success. */
  const runAction = useCallback(
    (proposalId: string, action: () => Promise<unknown>, successKey: string) => {
      setBusyId(proposalId);
      action()
        .then(() => {
          Message.success(t(successKey));
          refresh();
        })
        .catch((error: unknown) => {
          Message.error(error instanceof Error ? error.message : t('monitor.patch.actionError'));
        })
        .finally(() => setBusyId(undefined));
    },
    [refresh, t]
  );

  const approve = useCallback(
    (proposalId: string) =>
      runAction(proposalId, () => monitorClient.approvePatch(proposalId), 'monitor.patch.appliedToast'),
    [runAction]
  );
  const reject = useCallback(
    (proposalId: string) =>
      runAction(
        proposalId,
        () => monitorClient.rejectPatch(proposalId, 'Rejected by user'),
        'monitor.patch.rejectedToast'
      ),
    [runAction]
  );
  const rollback = useCallback(
    (proposalId: string) =>
      runAction(proposalId, () => monitorClient.rollbackPatch(proposalId), 'monitor.patch.rolledBackToast'),
    [runAction]
  );
  const fix = useCallback(
    (reportId: string) => runAction(reportId, () => monitorClient.fixReport(reportId), 'monitor.fix.startedToast'),
    [runAction]
  );

  /**
   * Publish an applied fix: push the branch to the fork, then open the GitHub
   * "create PR" compare URL so the user can open the PR (triggering the repo's
   * AI review). Separate from {@link runAction} because the success path opens a
   * URL and the message depends on whether the push actually succeeded.
   */
  const publish = useCallback(
    (proposalId: string) => {
      setBusyId(proposalId);
      monitorClient
        .publishFix(proposalId)
        .then((result) => {
          if (result.compareUrl) window.open(result.compareUrl, '_blank', 'noopener');
          if (result.pushed) {
            Message.success(t('monitor.publish.pushedToast', { branch: result.branch }));
          } else {
            Message.warning(result.detail || t('monitor.publish.notPushed', { branch: result.branch }));
          }
          refresh();
        })
        .catch((error: unknown) => {
          Message.error(error instanceof Error ? error.message : t('monitor.publish.error'));
        })
        .finally(() => setBusyId(undefined));
    },
    [refresh, t]
  );

  return { reports, proposals, status, busyId, refresh, fix, approve, reject, rollback, publish };
};
