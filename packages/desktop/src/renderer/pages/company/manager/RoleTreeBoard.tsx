/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Recursive role-tree board for the real-work pipeline (spec
 * agent-company-pipeline, Requirement 7). Renders the company hierarchy
 * (President → leads → workers, any depth) with each role's live activity and
 * who it is currently talking to — so you can watch the company work.
 *
 * Renderer-only. Arco + UnoCSS semantic tokens; all copy via i18n.
 */

import type { RoleRunState } from '../pipeline/pipelineTypes';
import { Crown, PeopleSpeak, User } from '@icon-park/react';
import { Tag, Tooltip } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

/** Map an activity to a tokenised Arco tag colour + a "live" flag. */
const activityStyle = (activity: RoleRunState['activity']): { tag: string; live: boolean } => {
  switch (activity) {
    case 'planning':
      return { tag: 'arcoblue', live: true };
    case 'delegating':
      return { tag: 'purple', live: true };
    case 'executing':
      return { tag: 'cyan', live: true };
    case 'testing':
      return { tag: 'gold', live: true };
    case 'awaiting-approval':
      return { tag: 'orange', live: true };
    case 'summarizing':
      return { tag: 'arcoblue', live: true };
    case 'done':
      return { tag: 'green', live: false };
    case 'failed':
      return { tag: 'red', live: false };
    default:
      return { tag: 'gray', live: false };
  }
};

/** A node in the rendered tree. */
type TreeNode = { state: RoleRunState; children: TreeNode[] };

/** Build a parent→children tree from the flat state map. */
const buildTree = (states: Record<string, RoleRunState>, rootId: string | null): TreeNode | null => {
  if (!rootId || !states[rootId]) return null;
  const byParent = new Map<string, RoleRunState[]>();
  for (const s of Object.values(states)) {
    if (!s.parentId) continue;
    const list = byParent.get(s.parentId) ?? [];
    list.push(s);
    byParent.set(s.parentId, list);
  }
  const make = (id: string): TreeNode => ({
    state: states[id],
    children: (byParent.get(id) ?? []).map((c) => make(c.nodeId)),
  });
  return make(rootId);
};

/** One role row, indented by depth. */
const RoleRow: React.FC<{ node: TreeNode; depth: number; nameById: Record<string, string> }> = ({
  node,
  depth,
  nameById,
}) => {
  const { t } = useTranslation();
  const { state } = node;
  const style = activityStyle(state.activity);
  const isPresident = state.role === 'president';
  const talkingTo = state.talkingToId ? nameById[state.talkingToId] : undefined;

  return (
    <div className='flex flex-col'>
      <div
        className={`flex items-center gap-8px rd-10px border border-solid px-10px py-8px transition-all duration-200 ${
          style.live ? 'border-primary bg-primary-1' : 'border-b-1 bg-1'
        }`}
        style={{ marginLeft: depth * 18 }}
      >
        <span
          className={`size-24px flex-center rd-6px ${isPresident ? 'bg-primary text-color-white' : 'bg-fill-2 text-t-secondary'}`}
        >
          {isPresident ? <Crown theme='filled' size='13' /> : <User theme='outline' size='13' />}
        </span>
        <span className='min-w-0 flex-1 truncate text-13px font-600 text-t-primary'>{state.name}</span>
        <Tag color={style.tag} size='small' bordered>
          {t(`company.pipeline.activity.${state.activity}`)}
        </Tag>
        {talkingTo && (
          <Tooltip content={talkingTo} mini>
            <span className='flex items-center gap-3px text-11px text-t-secondary'>
              <PeopleSpeak theme='outline' size='12' />
              {talkingTo}
            </span>
          </Tooltip>
        )}
        {style.live && <span className='size-7px rd-full bg-primary animate-pulse' />}
      </div>
      {node.children.length > 0 && (
        <div className='mt-6px flex flex-col gap-6px'>
          {node.children.map((c) => (
            <RoleRow key={c.state.nodeId} node={c} depth={depth + 1} nameById={nameById} />
          ))}
        </div>
      )}
    </div>
  );
};

/** The recursive role-tree board. */
const RoleTreeBoard: React.FC<{ states: Record<string, RoleRunState>; rootId: string | null }> = ({
  states,
  rootId,
}) => {
  const { t } = useTranslation();
  const tree = React.useMemo(() => buildTree(states, rootId), [states, rootId]);
  const nameById = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of Object.values(states)) map[s.nodeId] = s.name;
    return map;
  }, [states]);

  if (!tree) {
    return <p className='m-0 py-24px text-center text-12px text-t-tertiary'>{t('company.pipeline.boardEmpty')}</p>;
  }

  return (
    <div className='flex flex-col gap-6px'>
      <RoleRow node={tree} depth={0} nameById={nameById} />
    </div>
  );
};

export default RoleTreeBoard;
