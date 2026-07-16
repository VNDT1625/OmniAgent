/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CompanyRole, CompanyStructure, RoleNode } from '@process/company/companyOrchestrator';
import { Tag, Tooltip } from '@arco-design/web-react';
import { BuildingTwo, Components, Edit, People, Peoples, Robot, Terminal } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { roleLabelKey } from '../constants';

/** Per-role visual treatment (icon + accent color token) for clear hierarchy. */
const ROLE_STYLE: Record<CompanyRole, { color: string; tagColor: string }> = {
  president: { color: 'rgb(var(--primary-6))', tagColor: 'arcoblue' },
  'division-head': { color: 'rgb(var(--purple-6))', tagColor: 'purple' },
  worker: { color: 'rgb(var(--green-6))', tagColor: 'green' },
};

/** Pick a role-appropriate icon for a node. */
const RoleIcon: React.FC<{ role: CompanyRole; size?: string }> = ({ role, size = '18' }) => {
  if (role === 'president') return <BuildingTwo theme='outline' size={size} />;
  if (role === 'division-head') return <Peoples theme='outline' size={size} />;
  return <People theme='outline' size={size} />;
};

/** Small chip describing which executor backs a role (CLI / assistant / draft). */
const AssignmentChip: React.FC<{ node: RoleNode }> = ({ node }) => {
  const { t } = useTranslation();
  const a = node.assignment;
  if (!a) return null;

  const icon = a.kind === 'cli' ? <Terminal theme='outline' size='12' /> : <Robot theme='outline' size='12' />;
  const kindLabel =
    a.kind === 'cli'
      ? t('company.assignment.cli')
      : a.kind === 'assistant'
        ? t('company.assignment.assistant')
        : t('company.assignment.draft');

  if (a.kind === 'draft') {
    return (
      <Tag size='small' color='orange' className='shrink-0' icon={<Robot theme='outline' size='12' />}>
        {`${kindLabel}: ${a.label}`}
      </Tag>
    );
  }

  return (
    <Tooltip content={a.model ? t('company.structure.poweredBy', { model: a.model }) : kindLabel}>
      <span className='inline-flex items-center gap-4px text-11px text-t-secondary w-fit'>
        {icon}
        {`${kindLabel}: ${a.label}`}
        {a.model ? <span className='text-t-tertiary'>· {a.model}</span> : null}
      </span>
    </Tooltip>
  );
};

/**
 * One role card: a leading role-colored icon medallion, the role name, a role
 * badge, optional responsibilities line, the assigned executor (CLI/assistant/
 * draft), and the model that powers it. Division heads also summarise how many
 * workers they manage. An edit affordance lets the user re-assign the executor.
 */
const RoleCard: React.FC<{ node: RoleNode; model?: string; onEditAssignment?: (roleId: string) => void }> = ({
  node,
  model,
  onEditAssignment,
}) => {
  const { t } = useTranslation();
  const style = ROLE_STYLE[node.role];
  const workerCount = node.children.filter((child) => child.role === 'worker').length;
  const agentModel = node.assignment?.model ?? node.model ?? model;

  return (
    <div className='flex items-start gap-12px p-12px rd-12px bg-fill-1 border border-solid border-border-2'>
      <span
        className='shrink-0 size-36px rd-10px flex-center'
        style={{ backgroundColor: 'var(--color-fill-2)', color: style.color }}
      >
        <RoleIcon role={node.role} />
      </span>
      <div className='flex flex-col gap-4px min-w-0 flex-1'>
        <div className='flex items-center gap-8px flex-wrap'>
          <span className='text-14px font-600 text-t-primary truncate'>{node.name}</span>
          <Tag size='small' color={style.tagColor} className='shrink-0'>
            {t(roleLabelKey(node.role))}
          </Tag>
          {node.role !== 'worker' && workerCount > 0 && (
            <Tag size='small' className='shrink-0' icon={<People theme='outline' size='12' />}>
              {t('company.structure.workers', { count: workerCount })}
            </Tag>
          )}
          {onEditAssignment && (
            <span
              role='button'
              tabIndex={0}
              className='ml-auto shrink-0 inline-flex items-center gap-2px text-11px text-t-tertiary hover:text-t-primary cursor-pointer'
              onClick={() => onEditAssignment(node.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onEditAssignment(node.id);
              }}
            >
              <Edit theme='outline' size='12' />
              {t('company.assignment.change')}
            </span>
          )}
        </div>

        {node.responsibilities && (
          <p className='m-0 text-12px text-t-secondary leading-18px'>{node.responsibilities}</p>
        )}

        <div className='flex items-center gap-10px flex-wrap'>
          <AssignmentChip node={node} />
          {!node.assignment && agentModel && (
            <Tooltip content={t('company.structure.poweredByTip')}>
              <span className='inline-flex items-center gap-4px text-11px text-t-tertiary w-fit'>
                <Robot theme='outline' size='12' />
                {t('company.structure.poweredBy', { model: agentModel })}
              </span>
            </Tooltip>
          )}
        </div>

        <CapabilityChips node={node} />
      </div>
    </div>
  );
};

/** Compact chips summarising the capabilities granted to a role (MCP / skills / mode). */
const CapabilityChips: React.FC<{ node: RoleNode }> = ({ node }) => {
  const { t } = useTranslation();
  const caps = node.assignment?.capabilities;
  if (!caps) return null;
  const chips: React.ReactNode[] = [];
  if (caps.mcpServerIds && caps.mcpServerIds.length > 0) {
    chips.push(
      <Tag key='mcp' size='small' color='cyan' icon={<Components theme='outline' size='11' />}>
        {t('company.assignment.capMcp', { count: caps.mcpServerIds.length })}
      </Tag>
    );
  }
  if (caps.skills && caps.skills.length > 0) {
    chips.push(
      <Tag key='skills' size='small' color='green'>
        {t('company.assignment.capSkills', { count: caps.skills.length })}
      </Tag>
    );
  }
  if (caps.sessionMode) {
    chips.push(
      <Tag key='mode' size='small' color='gold'>
        {caps.sessionMode}
      </Tag>
    );
  }
  if (chips.length === 0) return null;
  return <div className='flex items-center gap-6px flex-wrap'>{chips}</div>;
};

/**
 * A compact chip representing a single worker agent. Shows its assigned executor
 * when set, and (when an editor callback is provided) acts as a button to
 * re-assign that worker's executor.
 */
const WorkerChip: React.FC<{ node: RoleNode; model?: string; onEditAssignment?: (roleId: string) => void }> = ({
  node,
  model,
  onEditAssignment,
}) => {
  const { t } = useTranslation();
  const a = node.assignment;
  const editable = Boolean(onEditAssignment);
  const label = a ? a.label : node.name;
  const tip = a
    ? `${a.kind === 'cli' ? t('company.assignment.cli') : a.kind === 'assistant' ? t('company.assignment.assistant') : t('company.assignment.draft')}: ${a.label}${a.model ? ` · ${a.model}` : ''}`
    : model
      ? t('company.structure.poweredBy', { model })
      : node.name;

  const isDraft = a?.kind === 'draft';

  return (
    <Tooltip content={editable ? `${tip} — ${t('company.assignment.change')}` : tip}>
      <span
        role={editable ? 'button' : undefined}
        tabIndex={editable ? 0 : undefined}
        onClick={editable ? () => onEditAssignment!(node.id) : undefined}
        onKeyDown={
          editable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') onEditAssignment!(node.id);
              }
            : undefined
        }
        className={`inline-flex items-center gap-6px px-10px py-5px rd-full text-12px ${editable ? 'cursor-pointer hover:bg-fill-3' : ''} ${isDraft ? 'bg-orange-1 text-orange-6' : 'bg-fill-2 text-t-secondary'}`}
      >
        <span style={{ color: isDraft ? 'rgb(var(--orange-6))' : ROLE_STYLE.worker.color }} className='flex-center'>
          {a?.kind === 'cli' ? <Terminal theme='outline' size='13' /> : <Robot theme='outline' size='13' />}
        </span>
        <span className='truncate max-w-180px'>{label}</span>
        {a?.model ? <span className='text-t-tertiary'>· {a.model}</span> : null}
        {editable ? <Edit theme='outline' size='12' /> : null}
      </span>
    </Tooltip>
  );
};

/** Render a division-head card with its worker chips grouped beneath it. */
const DivisionBranch: React.FC<{ node: RoleNode; model?: string; onEditAssignment?: (roleId: string) => void }> = ({
  node,
  model,
  onEditAssignment,
}) => {
  const { t } = useTranslation();
  const workers = node.children.filter((child) => child.role === 'worker');

  return (
    <div className='relative pl-22px'>
      {/* vertical connector from the president rail */}
      <span aria-hidden className='absolute left-0 top-0 bottom-0 w-1px bg-border-2' />
      <span aria-hidden className='absolute left-0 top-26px h-1px w-18px bg-border-2' />
      <div className='flex flex-col gap-8px'>
        <RoleCard node={node} model={model} onEditAssignment={onEditAssignment} />
        {workers.length > 0 ? (
          <div className='flex flex-wrap gap-6px pl-12px'>
            {workers.map((worker) => (
              <WorkerChip key={worker.id} node={worker} model={model} onEditAssignment={onEditAssignment} />
            ))}
          </div>
        ) : (
          <span className='pl-12px text-11px text-t-tertiary inline-flex items-center gap-4px'>
            <Components theme='outline' size='12' />
            {t('company.structure.noWorkers')}
          </span>
        )}
      </div>
    </div>
  );
};

/**
 * Render the elastic company role tree (criterion 3.2 view) as a clear card
 * hierarchy: a President card at the top, then each division head card with its
 * worker agents as chips. Each role shows its assigned executor (CLI/assistant/
 * draft) + model, and exposes an edit affordance to re-assign it.
 */
const RoleTree: React.FC<{ structure: CompanyStructure; onEditAssignment?: (roleId: string) => void }> = ({
  structure,
  onEditAssignment,
}) => {
  const { root, poweredByModel } = structure;
  const divisionHeads = root.children.filter((child) => child.role === 'division-head');
  const directWorkers = root.children.filter((child) => child.role === 'worker');

  return (
    <div className='flex flex-col gap-12px'>
      {/* President */}
      <RoleCard node={root} model={poweredByModel} onEditAssignment={onEditAssignment} />

      {/* Division heads + their workers */}
      {divisionHeads.length > 0 && (
        <div className='flex flex-col gap-12px'>
          {divisionHeads.map((head) => (
            <DivisionBranch key={head.id} node={head} model={poweredByModel} onEditAssignment={onEditAssignment} />
          ))}
        </div>
      )}

      {/* Small-company case: workers reporting straight to the President */}
      {directWorkers.length > 0 && (
        <div className='flex flex-wrap gap-6px pl-22px'>
          {directWorkers.map((worker) => (
            <WorkerChip key={worker.id} node={worker} model={poweredByModel} onEditAssignment={onEditAssignment} />
          ))}
        </div>
      )}
    </div>
  );
};

export default RoleTree;
