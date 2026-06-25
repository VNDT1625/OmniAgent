/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `BranchEditor` — edits the child pipelines (`branches`) of a control-flow node
 * (`control.if` then/else, `control.loop` body, `control.tryCatch` try/catch,
 * `control.switch` cases, `control.parallel` branches). Each branch is an ordered
 * list of child {@link WorkflowNode}s; the user adds a step (kind picker),
 * reorders (up/down), removes, and configures each child inline by reusing
 * {@link NodeConfigForm}. Switch/parallel branches can also be added/removed.
 *
 * Child nodes here are leaf/action nodes only — nesting another control node is
 * out of scope for this inline editor (the engine supports it, but the UI keeps
 * one level for clarity). Renderer-only; all text via i18n.
 */

import { Button, Collapse, Input, Select } from '@arco-design/web-react';
import { ArrowDown, ArrowUp, Delete, Plus } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkflowNode, WorkflowNodeKind } from '../automationClient';
import { metaFor, NODE_KIND_META } from '../nodeKindMeta';
import NodeConfigForm from './NodeConfigForm';

const CollapseItem = Collapse.Item;

/** Action node kinds offered inside a branch (control kinds excluded for clarity). */
const CHILD_KINDS: WorkflowNodeKind[] = NODE_KIND_META.map((m) => m.kind).filter(
  (k) => !k.startsWith('control.') && !k.startsWith('trigger.')
);

type BranchEditorProps = {
  /** The control node's kind — determines which branches are shown. */
  kind: WorkflowNodeKind;
  /** Current branches map. */
  branches: Record<string, WorkflowNode[]>;
  /** Commit an updated branches map. */
  onChange: (branches: Record<string, WorkflowNode[]>) => void;
};

let childSeq = 0;
const nextChildId = (): string => `c${Date.now().toString(36)}-${(childSeq++).toString(36)}`;

/** The fixed branch keys for each control kind (switch/parallel are dynamic). */
const fixedBranchKeys = (kind: WorkflowNodeKind): string[] => {
  switch (kind) {
    case 'control.if':
      return ['then', 'else'];
    case 'control.loop':
      return ['body'];
    case 'control.tryCatch':
      return ['try', 'catch'];
    default:
      return [];
  }
};

const BranchEditor: React.FC<BranchEditorProps> = ({ kind, branches, onChange }) => {
  const { t } = useTranslation();
  const [newCaseValue, setNewCaseValue] = useState('');

  /** Replace the nodes of one branch. */
  const setBranch = (key: string, nodes: WorkflowNode[]): void => onChange({ ...branches, [key]: nodes });

  /** Add a child node of the given kind to a branch. */
  const addChild = (key: string, childKind: WorkflowNodeKind): void => {
    const meta = metaFor(childKind);
    const child: WorkflowNode = {
      id: nextChildId(),
      kind: childKind,
      name: t(meta.labelKey),
      config: meta.defaultConfig(),
    };
    setBranch(key, [...(branches[key] ?? []), child]);
  };

  /** Patch a child node's config. */
  const patchChild = (key: string, childId: string, config: Record<string, unknown>): void => {
    setBranch(
      key,
      (branches[key] ?? []).map((c) => (c.id === childId ? { ...c, config } : c))
    );
  };

  /** Rename a child node. */
  const renameChild = (key: string, childId: string, name: string): void => {
    setBranch(
      key,
      (branches[key] ?? []).map((c) => (c.id === childId ? { ...c, name } : c))
    );
  };

  /** Remove a child node. */
  const removeChild = (key: string, childId: string): void => {
    setBranch(
      key,
      (branches[key] ?? []).filter((c) => c.id !== childId)
    );
  };

  /** Move a child up/down within its branch. */
  const moveChild = (key: string, index: number, delta: number): void => {
    const list = [...(branches[key] ?? [])];
    const next = index + delta;
    if (next < 0 || next >= list.length) return;
    [list[index], list[next]] = [list[next], list[index]];
    setBranch(key, list);
  };

  /** Determine which branch keys to render. */
  const dynamic = kind === 'control.switch' || kind === 'control.parallel';
  const keys = dynamic ? Object.keys(branches) : fixedBranchKeys(kind);

  const addDynamicBranch = (): void => {
    if (kind === 'control.switch') {
      const value = newCaseValue.trim();
      if (value.length === 0) return;
      onChange({ ...branches, [`case:${value}`]: branches[`case:${value}`] ?? [] });
      setNewCaseValue('');
    } else {
      // parallel: next branch index
      const existing = Object.keys(branches).filter((k) => k.startsWith('branch:')).length;
      onChange({ ...branches, [`branch:${existing}`]: [] });
    }
  };

  const removeDynamicBranch = (key: string): void => {
    const next = { ...branches };
    delete next[key];
    onChange(next);
  };

  /** Human label for a branch key. */
  const branchLabel = (key: string): string => {
    if (key === 'then') return t('automation.branch.then');
    if (key === 'else') return t('automation.branch.else');
    if (key === 'body') return t('automation.branch.body');
    if (key === 'try') return t('automation.branch.try');
    if (key === 'catch') return t('automation.branch.catch');
    if (key.startsWith('case:')) return `${t('automation.branch.case')}: ${key.slice(5)}`;
    if (key.startsWith('branch:')) return `${t('automation.branch.branch')} ${Number(key.slice(7)) + 1}`;
    return key;
  };

  return (
    <div className='flex flex-col gap-8px'>
      <span className='text-12px text-t-secondary font-[500]'>{t('automation.branch.title')}</span>

      <Collapse bordered={false}>
        {keys.map((key) => {
          const children = branches[key] ?? [];
          return (
            <CollapseItem
              key={key}
              name={key}
              header={
                <span className='text-13px font-[500]'>
                  {branchLabel(key)} ({children.length})
                </span>
              }
            >
              <div className='flex flex-col gap-8px'>
                {children.map((child, index) => (
                  <div key={child.id} className='rd-8px border border-b-1 p-8px flex flex-col gap-6px'>
                    <div className='flex items-center gap-4px'>
                      <Input
                        value={child.name}
                        onChange={(v) => renameChild(key, child.id, v)}
                        size='mini'
                        className='flex-1'
                      />
                      <Button
                        type='text'
                        size='mini'
                        icon={<ArrowUp theme='outline' size={12} />}
                        disabled={index === 0}
                        onClick={() => moveChild(key, index, -1)}
                        aria-label={t('automation.branch.moveUp')}
                      />
                      <Button
                        type='text'
                        size='mini'
                        icon={<ArrowDown theme='outline' size={12} />}
                        disabled={index === children.length - 1}
                        onClick={() => moveChild(key, index, 1)}
                        aria-label={t('automation.branch.moveDown')}
                      />
                      <Button
                        type='text'
                        size='mini'
                        status='danger'
                        icon={<Delete theme='outline' size={12} />}
                        onClick={() => removeChild(key, child.id)}
                        aria-label={t('automation.branch.removeChild')}
                      />
                    </div>
                    <span className='text-11px text-t-tertiary'>{t(metaFor(child.kind).labelKey)}</span>
                    <NodeConfigForm node={child} onChange={(config) => patchChild(key, child.id, config)} />
                  </div>
                ))}
                <ChildKindPicker onPick={(k) => addChild(key, k)} />
                {dynamic ? (
                  <Button type='text' size='mini' status='danger' onClick={() => removeDynamicBranch(key)}>
                    {t('automation.branch.removeBranch')}
                  </Button>
                ) : null}
              </div>
            </CollapseItem>
          );
        })}
      </Collapse>

      {kind === 'control.switch' ? (
        <div className='flex gap-6px'>
          <Input
            value={newCaseValue}
            onChange={setNewCaseValue}
            placeholder={t('automation.branch.caseValue')}
            size='small'
            className='flex-1'
          />
          <Button size='small' icon={<Plus theme='outline' size={13} />} onClick={addDynamicBranch}>
            {t('automation.branch.addCase')}
          </Button>
        </div>
      ) : null}
      {kind === 'control.parallel' ? (
        <Button size='small' icon={<Plus theme='outline' size={13} />} onClick={addDynamicBranch}>
          {t('automation.branch.addBranch')}
        </Button>
      ) : null}
    </div>
  );
};

/** A compact "add child step" kind picker. */
const ChildKindPicker: React.FC<{ onPick: (kind: WorkflowNodeKind) => void }> = ({ onPick }) => {
  const { t } = useTranslation();
  return (
    <Select
      placeholder={t('automation.branch.addChild')}
      size='mini'
      value={undefined}
      onChange={(v) => onPick(v as WorkflowNodeKind)}
      showSearch
    >
      {CHILD_KINDS.map((k) => (
        <Select.Option key={k} value={k}>
          {t(metaFor(k).labelKey)}
        </Select.Option>
      ))}
    </Select>
  );
};

export default BranchEditor;
