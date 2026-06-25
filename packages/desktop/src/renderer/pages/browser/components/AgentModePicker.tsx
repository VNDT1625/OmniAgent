/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Message, Select, Switch, Tooltip } from '@arco-design/web-react';
import { Aiming, Robot } from '@icon-park/react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useModelProviderList } from '@/renderer/hooks/agent/useModelProviderList';
import { useAgents } from '@/renderer/hooks/agent/useAgents';
import { makeCliModelId } from '@process/services/agentChat/cliModelId';

const SelectOption = Select.Option;
const SelectOptGroup = Select.OptGroup;

/**
 * Model picker + agent-mode toggle for the active browser tab (criterion 1.2).
 *
 * The user first picks one of their configured AI models, then flips the toggle
 * to turn the tab into a controllable "web agent". Without a chosen model the
 * toggle stays disabled. Enabling/disabling calls the `setAgentMode` channel via
 * {@link useBrowserState}; the actual control loop is wired by the
 * Browser-Control MCP (Task 6.6) — this only marks the tab.
 */
const AgentModePicker: React.FC<{
  /** Whether there is an active tab to toggle. */
  hasActiveTab: boolean;
  agentModel: string | null;
  agentMode: boolean;
  onModelChange: (model: string | null) => void;
  onToggle: (enabled: boolean) => Promise<void>;
  /** Suspend/resume the native browser view while a popup is open (z-index fix). */
  onOverlayOpen?: () => void;
  onOverlayClose?: () => void;
}> = ({ hasActiveTab, agentModel, agentMode, onModelChange, onToggle, onOverlayOpen, onOverlayClose }) => {
  const { t } = useTranslation();
  const { providers, getAvailableModels } = useModelProviderList();
  const { agents } = useAgents();

  // Flatten providers → unique model names for the picker.
  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: { value: string; label: string }[] = [];
    for (const provider of providers) {
      for (const model of getAvailableModels(provider)) {
        if (seen.has(model)) continue;
        seen.add(model);
        options.push({ value: model, label: model });
      }
    }
    return options;
  }, [providers, getAvailableModels]);

  // Runnable CLI agents (Claude Code, Codex, Gemini CLI…). Selecting one drives
  // the web agent through the CLI agent instead of an API-key provider, encoded
  // as the `cli:<agentId>` model id (see process/services/agentChat).
  const cliOptions = useMemo(() => {
    const options: { value: string; label: string }[] = [];
    for (const agent of agents) {
      if (agent.available === false) continue;
      options.push({ value: makeCliModelId(agent.id), label: agent.name });
    }
    return options;
  }, [agents]);

  const canToggle = hasActiveTab && Boolean(agentModel);

  const handleToggle = async (enabled: boolean) => {
    try {
      await onToggle(enabled);
      Message.success(enabled ? t('browser.agent.enabled') : t('browser.agent.disabled'));
    } catch {
      Message.error(t('browser.agent.toggleError'));
    }
  };

  return (
    <div className='flex items-center gap-10px'>
      <span className='flex items-center gap-6px shrink-0 text-t-secondary'>
        <Robot theme='outline' size='15' />
      </span>
      <Select
        className='w-200px'
        allowClear
        value={agentModel ?? undefined}
        placeholder={t('browser.agent.pickModel')}
        notFoundContent={<span className='text-12px text-t-tertiary'>{t('browser.agent.noModels')}</span>}
        onChange={(value: string | undefined) => onModelChange(value ?? null)}
        onVisibleChange={(visible) => (visible ? onOverlayOpen?.() : onOverlayClose?.())}
      >
        {/* Arco's Select reads OptGroup/Option from the STATIC JSX child tree —
            wrapping options in a helper that returns a Fragment makes it render
            empty group titles (the "two empty headers" bug). So render the
            groups/options inline. Show a header only for a non-empty group; when
            only one source has entries, render its options flat (no lone header). */}
        {cliOptions.length > 0 && modelOptions.length > 0
          ? [
              <SelectOptGroup key='cli' label={t('browser.agent.cliGroup')}>
                {cliOptions.map((option) => (
                  <SelectOption key={option.value} value={option.value}>
                    {`${option.label} · ${t('browser.agent.cliSuffix')}`}
                  </SelectOption>
                ))}
              </SelectOptGroup>,
              <SelectOptGroup key='api' label={t('browser.agent.providerGroup')}>
                {modelOptions.map((option) => (
                  <SelectOption key={option.value} value={option.value}>
                    {option.label}
                  </SelectOption>
                ))}
              </SelectOptGroup>,
            ]
          : cliOptions.length > 0
            ? cliOptions.map((option) => (
                <SelectOption key={option.value} value={option.value}>
                  {`${option.label} · ${t('browser.agent.cliSuffix')}`}
                </SelectOption>
              ))
            : modelOptions.map((option) => (
                <SelectOption key={option.value} value={option.value}>
                  {option.label}
                </SelectOption>
              ))}
      </Select>

      <Tooltip
        content={canToggle ? t('browser.agent.toggleHint') : t('browser.agent.pickModelFirst')}
        position='bottom'
      >
        <span className='flex items-center gap-8px h-32px px-12px rd-8px bg-fill-1'>
          <Aiming theme='outline' size='15' className={agentMode ? 'text-primary' : 'text-t-secondary'} />
          <span className='text-12px text-t-secondary whitespace-nowrap'>{t('browser.agent.label')}</span>
          <Switch
            size='small'
            aria-label={t('browser.agent.label')}
            checked={agentMode}
            disabled={!canToggle}
            onChange={handleToggle}
          />
        </span>
      </Tooltip>
    </div>
  );
};

export default AgentModePicker;
