/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission approval panel (Requirement 3 "Phần 2": the boss has authority to
 * approve / grant permission to employees). When an employee asks to do
 * something sensitive, its branch pauses and the request appears here for the
 * boss (or the human acting as boss) to approve or deny.
 *
 * Renderer-only. Arco + UnoCSS semantic tokens; all copy via i18n.
 */

import type { Participant, PermissionRequest } from '@process/company/companyConversation';
import { Check, Close, Lock } from '@icon-park/react';
import { Button } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

/** One pending permission request row. */
const RequestRow: React.FC<{
  request: PermissionRequest;
  requesterName: string;
  onResolve: (requestId: string, approved: boolean) => void;
}> = ({ request, requesterName, onResolve }) => {
  const { t } = useTranslation();
  return (
    <div className='flex flex-col gap-8px rd-12px border border-solid border-warning bg-warning-1 p-12px'>
      <div className='flex items-center gap-8px'>
        <span className='size-26px flex-center rd-8px bg-warning text-color-white'>
          <Lock theme='outline' size='15' />
        </span>
        <p className='m-0 flex-1 text-12px text-t-secondary'>
          <span className='font-600 text-t-primary'>{requesterName}</span> {t('company.conversation.permission.asks')}
        </p>
      </div>
      <p className='m-0 text-13px font-600 text-t-primary'>{request.action}</p>
      {request.reason && <p className='m-0 text-12px text-t-secondary'>{request.reason}</p>}
      <div className='flex items-center justify-end gap-8px'>
        <Button size='small' icon={<Close theme='outline' size='13' />} onClick={() => onResolve(request.id, false)}>
          {t('company.conversation.permission.deny')}
        </Button>
        <Button
          type='primary'
          size='small'
          icon={<Check theme='outline' size='13' />}
          onClick={() => onResolve(request.id, true)}
        >
          {t('company.conversation.permission.approve')}
        </Button>
      </div>
    </div>
  );
};

/** The full pending-permission list. */
const PermissionPanel: React.FC<{
  pending: PermissionRequest[];
  participants: Participant[];
  onResolve: (requestId: string, approved: boolean) => void;
}> = ({ pending, participants, onResolve }) => {
  if (pending.length === 0) return null;
  const nameById: Record<string, string> = {};
  for (const p of participants) nameById[p.id] = p.name;

  return (
    <div className='flex flex-col gap-10px'>
      {pending.map((req) => (
        <RequestRow
          key={req.id}
          request={req}
          requesterName={nameById[req.fromId] ?? req.fromId}
          onResolve={onResolve}
        />
      ))}
    </div>
  );
};

export default PermissionPanel;
