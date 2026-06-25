/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RoleAssignment, RoleCapabilities } from '@process/company/companyOrchestrator';
import type { ListAgentsResponse } from '@process/company/companyBridge';
import { Modal, Select } from '@arco-design/web-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Modal to (re)assign one company role to an executor AND grant its
 * capabilities (Requirement 9): pick a CLI engine or assistant + a model, then
 * choose which MCP servers it may use, which skills are enabled, and the
 * permission/"super" session mode it runs in. Without capabilities a role often
 * cannot do its job (browse the web, edit Office files, run sensitive commands).
 *
 * Draft assignments are not editable here — they are accepted in batch from the
 * structure panel; this editor only switches a role to a real CLI/assistant.
 *
 * Arco-only, semantic tokens, all strings via `t('company.assignment.*')`.
 */
const AssignmentEditor: React.FC<{
  visible: boolean;
  roleId: string | null;
  roleName: string;
  current?: RoleAssignment;
  agents: ListAgentsResponse;
  onCancel: () => void;
  onConfirm: (roleId: string, assignment: RoleAssignment) => void;
}> = ({ visible, roleId, roleName, current, agents, onCancel, onConfirm }) => {
  const { t } = useTranslation();

  // Combined option value is `"<kind>:<id>"` so CLI and assistant ids never clash.
  const [executor, setExecutor] = useState<string | undefined>(undefined);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [mcpServerIds, setMcpServerIds] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [sessionMode, setSessionMode] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!visible) return;
    if (current && (current.kind === 'cli' || current.kind === 'assistant')) {
      setExecutor(`${current.kind}:${current.refId}`);
    } else {
      setExecutor(undefined);
    }
    setModel(current?.model);
    setMcpServerIds(current?.capabilities?.mcpServerIds ?? []);
    setSkills(current?.capabilities?.skills ?? []);
    setSessionMode(current?.capabilities?.sessionMode);
  }, [visible, current]);

  const cliOptions = useMemo(
    () => agents.clis.map((c) => ({ value: `cli:${c.id}`, label: c.name, disabled: !c.available })),
    [agents.clis]
  );
  const assistantOptions = useMemo(
    () => agents.assistants.map((a) => ({ value: `assistant:${a.id}`, label: a.name })),
    [agents.assistants]
  );

  const handleConfirm = () => {
    if (!roleId || !executor) return;
    const sep = executor.indexOf(':');
    const kind = executor.slice(0, sep) as 'cli' | 'assistant';
    const refId = executor.slice(sep + 1);
    const source =
      kind === 'cli' ? agents.clis.find((c) => c.id === refId) : agents.assistants.find((a) => a.id === refId);
    const label = source?.name ?? refId;

    // A CLI manages its own model — never attach a company-level model to a CLI
    // role (it would only mislead; it is ignored at runtime).
    const effectiveModel = kind === 'cli' ? undefined : model;

    // Only attach a capabilities object when something is actually granted, so
    // roles without special needs stay clean (executor defaults only).
    const capabilities: RoleCapabilities = {};
    if (mcpServerIds.length > 0) capabilities.mcpServerIds = mcpServerIds;
    if (skills.length > 0) capabilities.skills = skills;
    if (sessionMode) capabilities.sessionMode = sessionMode;
    const hasCapabilities = Object.keys(capabilities).length > 0;

    const assignment: RoleAssignment = {
      kind,
      refId,
      label,
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(hasCapabilities ? { capabilities } : {}),
    };
    onConfirm(roleId, assignment);
  };

  /** Whether the currently selected executor is a CLI (model is CLI-managed). */
  const isCliSelected = executor?.startsWith('cli:') ?? false;

  return (
    <Modal
      visible={visible}
      title={t('company.assignment.editorTitle', { role: roleName })}
      onCancel={onCancel}
      onOk={handleConfirm}
      okButtonProps={{ disabled: !executor }}
      okText={t('company.assignment.save')}
      cancelText={t('common.cancel')}
      autoFocus={false}
      unmountOnExit
    >
      <div className='flex flex-col gap-16px py-4px'>
        <div className='flex flex-col gap-6px'>
          <span className='text-13px font-500 text-t-primary'>{t('company.assignment.pickExecutor')}</span>
          <Select
            value={executor}
            onChange={setExecutor}
            placeholder={t('company.assignment.pickExecutor')}
            showSearch
            allowClear
            filterOption={(input, option) =>
              String((option?.props as { children?: unknown } | undefined)?.children ?? '')
                .toLowerCase()
                .includes(input.toLowerCase())
            }
          >
            <Select.OptGroup label={t('company.assignment.cliGroup')}>
              {cliOptions.map((o) => (
                <Select.Option key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </Select.Option>
              ))}
            </Select.OptGroup>
            <Select.OptGroup label={t('company.assignment.assistantGroup')}>
              {assistantOptions.map((o) => (
                <Select.Option key={o.value} value={o.value}>
                  {o.label}
                </Select.Option>
              ))}
            </Select.OptGroup>
          </Select>
        </div>

        <div className='flex flex-col gap-6px'>
          <span className='text-13px font-500 text-t-primary'>{t('company.assignment.pickModel')}</span>
          <Select
            value={isCliSelected ? undefined : model}
            onChange={setModel}
            placeholder={isCliSelected ? t('company.assignment.modelCliManaged') : t('company.assignment.pickModel')}
            showSearch
            allowClear
            disabled={isCliSelected}
          >
            {agents.models.map((m) => (
              <Select.Option key={m.id} value={m.id}>
                {m.name}
              </Select.Option>
            ))}
          </Select>
          {isCliSelected && (
            <span className='text-11px text-t-tertiary'>{t('company.assignment.modelCliManagedHint')}</span>
          )}
        </div>

        {/* Capabilities (Requirement 9) ------------------------------------ */}
        <div className='h-1px bg-3' />
        <span className='text-12px font-600 uppercase tracking-wide text-t-tertiary'>
          {t('company.assignment.capabilitiesTitle')}
        </span>

        <div className='flex flex-col gap-6px'>
          <span className='text-13px font-500 text-t-primary'>{t('company.assignment.pickMcp')}</span>
          <Select
            mode='multiple'
            value={mcpServerIds}
            onChange={setMcpServerIds}
            placeholder={t('company.assignment.pickMcpPlaceholder')}
            allowClear
            showSearch
            filterOption={(input, option) =>
              String((option?.props as { children?: unknown } | undefined)?.children ?? '')
                .toLowerCase()
                .includes(input.toLowerCase())
            }
          >
            {agents.mcpServers.map((s) => (
              <Select.Option key={s.id} value={s.id}>
                {s.builtin ? `${s.name} · ${t('company.assignment.mcpBuiltin')}` : s.name}
              </Select.Option>
            ))}
          </Select>
        </div>

        <div className='flex flex-col gap-6px'>
          <span className='text-13px font-500 text-t-primary'>{t('company.assignment.pickSkills')}</span>
          <Select
            mode='multiple'
            value={skills}
            onChange={setSkills}
            placeholder={t('company.assignment.pickSkillsPlaceholder')}
            allowClear
            showSearch
            filterOption={(input, option) =>
              String((option?.props as { children?: unknown } | undefined)?.children ?? '')
                .toLowerCase()
                .includes(input.toLowerCase())
            }
          >
            {agents.skills.map((s) => (
              <Select.Option key={s.name} value={s.name}>
                {s.name}
              </Select.Option>
            ))}
          </Select>
        </div>

        <div className='flex flex-col gap-6px'>
          <span className='text-13px font-500 text-t-primary'>{t('company.assignment.pickMode')}</span>
          <Select
            value={sessionMode}
            onChange={setSessionMode}
            placeholder={t('company.assignment.pickModePlaceholder')}
            allowClear
            showSearch
          >
            {agents.modes.map((m) => (
              <Select.Option key={`${m.engine}:${m.value}`} value={m.value}>
                {`${m.label} · ${m.engine}`}
              </Select.Option>
            ))}
          </Select>
          <span className='text-11px text-t-tertiary'>{t('company.assignment.modeHint')}</span>
        </div>
      </div>
    </Modal>
  );
};

export default AssignmentEditor;
