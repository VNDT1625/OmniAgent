/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `WorkflowList` — the left-rail list of saved workflows. Each row shows the
 * workflow name + step count and, on hover, a delete affordance. Selecting a row
 * loads it into the editor. Presentational; all text via i18n.
 */

import { Button } from '@arco-design/web-react';
import { Delete } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { Workflow } from '../automationClient';

type WorkflowListProps = {
  workflows: Workflow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string, name: string) => void;
};

const WorkflowList: React.FC<WorkflowListProps> = ({ workflows, selectedId, onSelect, onRemove }) => {
  const { t } = useTranslation();
  return (
    <div className='flex flex-col gap-2px'>
      {workflows.map((workflow) => {
        const active = workflow.id === selectedId;
        return (
          <div
            key={workflow.id}
            role='button'
            tabIndex={0}
            onClick={() => onSelect(workflow.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSelect(workflow.id);
            }}
            className={`group flex items-center gap-8px px-10px py-8px rd-8px cursor-pointer border-none transition-colors ${active ? 'bg-primary-light-1' : 'bg-transparent hover:bg-fill-1'}`}
          >
            <span className='flex flex-col min-w-0 flex-1'>
              <span className={`text-13px font-[500] truncate ${active ? 'text-primary' : 'text-t-primary'}`}>
                {workflow.name}
              </span>
              <span className='text-11px text-t-tertiary'>
                {t('automation.stepCount', { count: workflow.nodes.length })}
              </span>
            </span>
            <Button
              type='text'
              size='mini'
              status='danger'
              className='opacity-0 group-hover:opacity-100 transition-opacity'
              aria-label={t('automation.remove.confirm')}
              icon={<Delete theme='outline' size={13} />}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(workflow.id, workflow.name);
              }}
            />
          </div>
        );
      })}
    </div>
  );
};

export default WorkflowList;
