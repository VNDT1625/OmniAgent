/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ProposalCard` — renders one auto-generated patch proposal (Yêu cầu 6,
 * criteria 6.3 / 6.5 / 6.6 / 6.7) with its root cause, explanation, risk tag,
 * current gate status, and the approval-gate actions (approve & apply / reject /
 * roll back). Action availability follows the gate state machine:
 *
 * - `proposed` / `pending-review` → Approve & apply, Reject.
 * - `applied`                     → Roll back.
 * - `rejected` / `rolled-back`    → no actions (terminal for the UI).
 *
 * Presentational: all side effects are delegated to the injected callbacks so
 * the parent owns the bridge calls + refresh. Renderer-only.
 */

import { Button, Popconfirm, Tag } from '@arco-design/web-react';
import { CheckOne, CloseOne, Undo, Upload } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { MonitorProposal } from '../monitorBridgeClient';

/** Map a risk level to an Arco tag colour. */
const RISK_COLOR: Record<string, string> = { low: 'green', medium: 'orange', high: 'red' };

/** Map a gate status to a status-dot colour class. */
const STATUS_COLOR: Record<string, string> = {
  proposed: 'text-t-tertiary',
  'pending-review': 'text-warning',
  approved: 'text-primary',
  applied: 'text-success',
  rejected: 'text-danger',
  'rolled-back': 'text-t-tertiary',
};

/** Props for {@link ProposalCard}. */
export type ProposalCardProps = {
  /** The proposal to render. */
  proposal: MonitorProposal;
  /** Whether an action on this card is in flight (disables buttons). */
  busy: boolean;
  /** Approve & apply this proposal. */
  onApprove: (proposalId: string) => void;
  /** Reject this proposal. */
  onReject: (proposalId: string) => void;
  /** Roll back this (applied) proposal. */
  onRollback: (proposalId: string) => void;
  /** Publish this (applied) proposal as a fix branch on the fork. */
  onPublish: (proposalId: string) => void;
};

/** A single patch-proposal card with gate actions. */
const ProposalCard: React.FC<ProposalCardProps> = ({ proposal, busy, onApprove, onReject, onRollback, onPublish }) => {
  const { t } = useTranslation();
  const canReview = proposal.status === 'proposed' || proposal.status === 'pending-review';
  const canRollback = proposal.status === 'applied';
  const canPublish = proposal.status === 'applied';
  const statusLabel = t(`monitor.status.${proposal.status}`, { defaultValue: proposal.status });

  return (
    <div
      className='border border-border-base rd-8px p-12px flex flex-col gap-8px bg-fill-1'
      data-testid='proposal-item'
    >
      <div className='flex items-start justify-between gap-8px'>
        <span className='text-13px font-600 text-t-primary'>{proposal.rootCause || t('monitor.patch.title')}</span>
        <div className='flex items-center gap-6px shrink-0'>
          <Tag size='small' color={RISK_COLOR[proposal.risk] ?? 'gray'}>
            {t('monitor.patch.risk')}: {t(`monitor.risk.${proposal.risk}`, { defaultValue: proposal.risk })}
          </Tag>
          <span className={`text-11px ${STATUS_COLOR[proposal.status] ?? 'text-t-tertiary'}`}>{statusLabel}</span>
        </div>
      </div>

      <p className='m-0 text-12px text-t-secondary line-clamp-3'>{proposal.explanation}</p>

      {proposal.rejectedReason ? <p className='m-0 text-11px text-danger'>{proposal.rejectedReason}</p> : null}

      <div className='flex items-center gap-8px'>
        {canReview ? (
          <>
            <Popconfirm
              focusLock
              title={t('monitor.patch.approveConfirm')}
              onOk={() => onApprove(proposal.proposalId)}
              okText={t('monitor.patch.approve')}
              cancelText={t('monitor.patch.cancel')}
            >
              <Button type='primary' size='mini' loading={busy} icon={<CheckOne theme='outline' size='13' />}>
                {t('monitor.patch.approve')}
              </Button>
            </Popconfirm>
            <Button
              size='mini'
              status='danger'
              disabled={busy}
              icon={<CloseOne theme='outline' size='13' />}
              onClick={() => onReject(proposal.proposalId)}
            >
              {t('monitor.patch.reject')}
            </Button>
          </>
        ) : null}

        {canRollback ? (
          <Button
            size='mini'
            disabled={busy}
            icon={<Undo theme='outline' size='13' />}
            onClick={() => onRollback(proposal.proposalId)}
          >
            {t('monitor.patch.rollback')}
          </Button>
        ) : null}

        {canPublish ? (
          <Popconfirm
            focusLock
            title={t('monitor.publish.confirm')}
            onOk={() => onPublish(proposal.proposalId)}
            okText={t('monitor.patch.publish')}
            cancelText={t('monitor.patch.cancel')}
          >
            <Button type='outline' size='mini' loading={busy} icon={<Upload theme='outline' size='13' />}>
              {t('monitor.patch.publish')}
            </Button>
          </Popconfirm>
        ) : null}
      </div>
    </div>
  );
};

export default ProposalCard;
