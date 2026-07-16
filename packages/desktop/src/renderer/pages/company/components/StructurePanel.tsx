/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CompanyStructure, RoleAssignment, RoleNode } from '@process/company/companyOrchestrator';
import type { ListAgentsResponse, StructureDivisionInput } from '@process/company/companyBridge';
import { Button, Message, Spin } from '@arco-design/web-react';
import { CheckOne, Components, Edit, Refresh, Tree } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CompanyLoadStatus } from '../useCompanyState';
import AssignmentEditor from './AssignmentEditor';
import RoleTree from './RoleTree';
import SectionCard from './SectionCard';
import StructureEditor from './StructureEditor';

/** Depth-first find of a role node by id. */
const findRole = (node: RoleNode, id: string): RoleNode | undefined => {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findRole(child, id);
    if (found) return found;
  }
  return undefined;
};

/**
 * View the generated role tree/structure for the active company, with per-role
 * executor assignment (CLI / assistant) and a batch "accept draft assistants"
 * action when the generator proposed new assistants.
 *
 * Handles the four load states from {@link useCompanyState}: a spinner while
 * loading, a friendly empty state, a friendly error state, and the rendered
 * {@link RoleTree} when ready.
 */
const StructurePanel: React.FC<{
  structure: CompanyStructure | null;
  status: CompanyLoadStatus;
  onRefresh: () => void;
  agents: ListAgentsResponse;
  draftCount: number;
  onSetAssignment: (roleId: string, assignment: RoleAssignment) => Promise<boolean>;
  onAcceptDrafts: () => Promise<number>;
  onUpdateStructure: (input: { presidentName?: string; divisions: StructureDivisionInput[] }) => Promise<boolean>;
}> = ({ structure, status, onRefresh, agents, draftCount, onSetAssignment, onAcceptDrafts, onUpdateStructure }) => {
  const { t } = useTranslation();
  const [editRoleId, setEditRoleId] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [structureEditorOpen, setStructureEditorOpen] = useState(false);

  const editRole = structure && editRoleId ? findRole(structure.root, editRoleId) : undefined;

  const handleConfirm = (roleId: string, assignment: RoleAssignment) => {
    setEditRoleId(null);
    void onSetAssignment(roleId, assignment).then((ok) => {
      if (ok) Message.success(t('company.assignment.saved'));
      else Message.error(t('company.assignment.saveError'));
    });
  };

  const handleAccept = () => {
    setAccepting(true);
    void onAcceptDrafts()
      .then((created) => {
        if (created > 0) Message.success(t('company.assignment.acceptSuccess', { count: created }));
        else Message.error(t('company.assignment.acceptError'));
      })
      .finally(() => setAccepting(false));
  };

  return (
    <SectionCard
      icon={<Tree theme='outline' size='18' />}
      title={t('company.structure.title')}
      subtitle={t('company.structure.subtitle')}
      extra={
        <div className='flex items-center gap-8px'>
          <Button size='small' icon={<Edit theme='outline' size='14' />} onClick={() => setStructureEditorOpen(true)}>
            {t('company.editor.editButton')}
          </Button>
          <Button
            size='small'
            icon={<Refresh theme='outline' size='14' />}
            onClick={onRefresh}
            disabled={status === 'loading'}
          >
            {t('company.structure.refresh')}
          </Button>
        </div>
      }
    >
      {status === 'loading' && (
        <div className='flex-center py-40px'>
          <Spin size={24} />
        </div>
      )}

      {status === 'error' && (
        <div className='flex flex-col items-center gap-12px py-32px text-center'>
          <span className='size-44px flex-center rd-full bg-fill-2 text-t-tertiary'>
            <Components theme='outline' size='22' />
          </span>
          <p className='m-0 max-w-420px text-13px text-t-secondary'>{t('company.structure.loadError')}</p>
        </div>
      )}

      {(status === 'idle' || (status === 'ready' && !structure)) && (
        <p className='m-0 text-13px text-t-tertiary'>{t('company.structure.empty')}</p>
      )}

      {status === 'ready' && structure && (
        <div className='flex flex-col gap-12px'>
          {draftCount > 0 && (
            <div className='flex items-center gap-12px p-12px rd-12px bg-orange-1 border border-solid border-orange-3'>
              <span className='text-12px text-t-secondary flex-1'>
                {t('company.assignment.draftBanner', { count: draftCount })}
              </span>
              <Button
                type='primary'
                size='small'
                loading={accepting}
                icon={<CheckOne theme='outline' size='14' />}
                onClick={handleAccept}
              >
                {t('company.assignment.acceptAll', { count: draftCount })}
              </Button>
            </div>
          )}
          <RoleTree structure={structure} onEditAssignment={setEditRoleId} />
        </div>
      )}

      <AssignmentEditor
        visible={Boolean(editRole)}
        roleId={editRoleId}
        roleName={editRole?.name ?? ''}
        current={editRole?.assignment}
        agents={agents}
        onCancel={() => setEditRoleId(null)}
        onConfirm={handleConfirm}
      />

      <StructureEditor
        visible={structureEditorOpen}
        structure={structure}
        onCancel={() => setStructureEditorOpen(false)}
        onSave={onUpdateStructure}
      />
    </SectionCard>
  );
};

export default StructurePanel;
