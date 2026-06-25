/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The workspace chat composer — the input where the user types one instruction
 * ("vừa search web A vừa edit B"), picks the model that drives the sub-agents,
 * and runs it. The instruction is parsed into one surface per detected target so
 * the run fans out into parallel frames.
 *
 * Renderer-only; Arco + UnoCSS + i18n. No raw interactive HTML.
 */

import { Button, Input, Select } from '@arco-design/web-react';
import { Play, PauseOne } from '@icon-park/react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useModelProviderList } from '@/renderer/hooks/agent/useModelProviderList';

const SelectOption = Select.Option;
const TextArea = Input.TextArea;

/** Props for {@link WorkspaceComposer}. */
export type WorkspaceComposerProps = {
  /** Current instruction draft. */
  draft: string;
  /** Selected model id driving the sub-agents. */
  model: string | null;
  /** Whether a run is currently in flight. */
  running: boolean;
  /** Update the instruction draft. */
  onDraftChange: (value: string) => void;
  /** Update the selected model. */
  onModelChange: (model: string | null) => void;
  /** Start a run from the current draft. */
  onRun: () => void;
  /** Stop the in-flight run. */
  onStop: () => void;
};

/** Instruction input + model picker + run/stop control. */
const WorkspaceComposer: React.FC<WorkspaceComposerProps> = ({
  draft,
  model,
  running,
  onDraftChange,
  onModelChange,
  onRun,
  onStop,
}) => {
  const { t } = useTranslation();
  const { providers, getAvailableModels } = useModelProviderList();

  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: { value: string; label: string }[] = [];
    for (const provider of providers) {
      for (const m of getAvailableModels(provider)) {
        if (seen.has(m)) continue;
        seen.add(m);
        options.push({ value: m, label: m });
      }
    }
    return options;
  }, [providers, getAvailableModels]);

  const canRun = !running && draft.trim().length > 0 && Boolean(model);

  // Cmd/Ctrl+Enter runs; plain Enter inserts a newline (multi-line instructions).
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canRun) {
      e.preventDefault();
      onRun();
    }
  };

  return (
    <div className='flex flex-col gap-10px rd-12px border border-solid border-line-2 bg-base p-12px'>
      <TextArea
        className='text-14px'
        autoSize={{ minRows: 2, maxRows: 6 }}
        value={draft}
        placeholder={t('workspace.composer.placeholder')}
        onChange={(value: string) => onDraftChange(value)}
        onKeyDown={handleKeyDown}
      />
      <div className='flex items-center justify-between gap-12px flex-wrap'>
        <Select
          className='w-240px'
          allowClear
          value={model ?? undefined}
          placeholder={t('workspace.composer.pickModel')}
          notFoundContent={<span className='text-12px text-t-tertiary'>{t('workspace.composer.noModels')}</span>}
          onChange={(value: string | undefined) => onModelChange(value ?? null)}
        >
          {modelOptions.map((option) => (
            <SelectOption key={option.value} value={option.value}>
              {option.label}
            </SelectOption>
          ))}
        </Select>
        <div className='flex items-center gap-8px'>
          {running ? (
            <Button status='danger' icon={<PauseOne theme='outline' size='15' />} onClick={onStop}>
              {t('workspace.composer.stop')}
            </Button>
          ) : (
            <Button type='primary' icon={<Play theme='outline' size='15' />} disabled={!canRun} onClick={onRun}>
              {t('workspace.composer.run')}
            </Button>
          )}
        </div>
      </div>
      <span className='text-12px text-t-tertiary'>{t('workspace.composer.hint')}</span>
    </div>
  );
};

export default WorkspaceComposer;
