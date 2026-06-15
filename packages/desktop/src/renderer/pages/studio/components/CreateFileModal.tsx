/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `CreateFileModal` — the Studio "new file" dialog. Two modes via a segmented
 * switch:
 * - **Empty** — name a file; it is created blank (the original behaviour).
 * - **Generate** — describe what the file should contain and optionally attach
 *   reference files; a content agent ({@link useFileCreator}) authors the body
 *   with the picked model, writes it in the right shape for the file type, and
 *   hands the path up so the parent opens it in the editor.
 *
 * Presentational + flow only; the agent logic lives in {@link useFileCreator}.
 * Arco + `@icon-park/react` + UnoCSS semantic tokens, all text via i18n.
 * Renderer-only.
 */

import { Button, Input, Message, Modal, Radio, Select, Tooltip } from '@arco-design/web-react';
import { CloseSmall, DocAdd, FileAddition, Lightning, Paperclip, Robot } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { useModelProviderList } from '@/renderer/hooks/agent/useModelProviderList';
import { baseName } from '../studioStorage';
import { kindSupportsGeneration, useFileCreator, type CreateMode, type CreatorStatus } from '../hooks/useFileCreator';

const { TextArea } = Input;
const STUDIO_MODEL_KEY = 'studio.lastModel';

type CreateFileModalProps = {
  visible: boolean;
  /** Close without creating. */
  onCancel: () => void;
  /** Called with the absolute path once a file has been created. */
  onCreated: (filePath: string) => void;
};

/** Map a creator status to its i18n progress label key. */
const STATUS_LABEL: Record<Exclude<CreatorStatus, 'idle'>, string> = {
  reading: 'studio.create.statusReading',
  generating: 'studio.create.statusGenerating',
  writing: 'studio.create.statusWriting',
};

const CreateFileModal: React.FC<CreateFileModalProps> = ({ visible, onCancel, onCreated }) => {
  const { t } = useTranslation();
  const { providers, getAvailableModels } = useModelProviderList();
  const { status, busy, create, reset } = useFileCreator();

  const [name, setName] = useState('');
  const [mode, setMode] = useState<CreateMode>('empty');
  const [description, setDescription] = useState('');
  const [references, setReferences] = useState<string[]>([]);
  const [model, setModel] = useState<string | null>(() => localStorage.getItem(STUDIO_MODEL_KEY));

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

  // Reset transient state whenever the modal opens.
  useEffect(() => {
    if (!visible) return;
    setName('');
    setDescription('');
    setReferences([]);
    setMode('empty');
    reset();
  }, [visible, reset]);

  useEffect(() => {
    if (!model && modelOptions.length > 0) setModel(modelOptions[0].value);
  }, [model, modelOptions]);

  const handlePickModel = (value: string): void => {
    setModel(value);
    try {
      localStorage.setItem(STUDIO_MODEL_KEY, value);
    } catch {
      /* storage unavailable — non-fatal */
    }
  };

  const trimmedName = name.trim();
  const canGenerate = kindSupportsGeneration(trimmedName);
  // A non-generatable type silently behaves as "empty" even if the toggle is on.
  const effectiveMode: CreateMode = mode === 'generate' && canGenerate ? 'generate' : 'empty';
  const needsDescription = effectiveMode === 'generate';
  const okDisabled = trimmedName.length === 0 || (needsDescription && (description.trim().length === 0 || !model));

  const handleAttach = async (): Promise<void> => {
    const picked = await ipcBridge.dialog.showOpen.invoke({ properties: ['openFile', 'multiSelections'] });
    if (!picked || picked.length === 0) return;
    setReferences((prev) => {
      const merged = [...prev];
      for (const p of picked) if (!merged.includes(p)) merged.push(p);
      return merged.slice(0, 5);
    });
  };

  const removeReference = (path: string): void => {
    setReferences((prev) => prev.filter((p) => p !== path));
  };

  const handleCreate = async (): Promise<void> => {
    if (trimmedName.length === 0) return;
    const dirs = await ipcBridge.dialog.showOpen.invoke({ properties: ['openDirectory'] });
    if (!dirs || dirs.length === 0) return;

    const filePath = await create({
      dir: dirs[0],
      name: trimmedName,
      mode: effectiveMode,
      model,
      description,
      references,
    });

    if (filePath) {
      onCreated(filePath);
      return;
    }
    Message.error(t('studio.create.failed'));
  };

  const progressLabel = status === 'idle' ? '' : t(STATUS_LABEL[status]);

  return (
    <Modal
      title={
        <span className='flex items-center gap-8px'>
          <span className='flex-center size-26px rd-8px bg-primary-light-1 text-primary'>
            <FileAddition theme='outline' size={15} />
          </span>
          {t('studio.create.title')}
        </span>
      }
      visible={visible}
      onCancel={onCancel}
      footer={null}
      style={{ width: 520 }}
      unmountOnExit
    >
      <div className='flex flex-col gap-16px'>
        {/* File name */}
        <div className='flex flex-col gap-6px'>
          <span className='text-13px font-[500] text-t-secondary'>{t('studio.create.nameLabel')}</span>
          <Input value={name} onChange={setName} placeholder={t('studio.create.placeholder')} autoFocus allowClear />
        </div>

        {/* Mode switch */}
        <Radio.Group type='button' value={mode} onChange={(v) => setMode(v as CreateMode)} className='w-full'>
          <Radio value='empty'>
            <span className='flex items-center gap-6px'>
              <DocAdd theme='outline' size={14} />
              {t('studio.create.modeEmpty')}
            </span>
          </Radio>
          <Radio value='generate' disabled={trimmedName.length > 0 && !canGenerate}>
            <span className='flex items-center gap-6px'>
              <Lightning theme='outline' size={14} />
              {t('studio.create.modeGenerate')}
            </span>
          </Radio>
        </Radio.Group>

        {mode === 'generate' && trimmedName.length > 0 && !canGenerate ? (
          <div className='text-12px text-warning bg-warning-light-1 rd-8px px-10px py-8px leading-relaxed'>
            {t('studio.create.unsupportedKind')}
          </div>
        ) : null}

        {/* Generate panel */}
        {effectiveMode === 'generate' ? (
          <div className='flex flex-col gap-14px rd-12px border border-b-1 bg-2 p-14px'>
            <div className='flex items-center gap-8px text-t-primary'>
              <Robot theme='outline' size={16} className='text-primary' />
              <span className='text-13px font-600'>{t('studio.create.agentTitle')}</span>
            </div>

            {/* Model picker */}
            <div className='flex flex-col gap-6px'>
              <span className='text-12px text-t-tertiary'>{t('studio.create.modelLabel')}</span>
              <Select
                value={model ?? undefined}
                placeholder={t('studio.create.pickModel')}
                onChange={handlePickModel}
                showSearch
                size='small'
                className='w-full'
              >
                {modelOptions.map((opt) => (
                  <Select.Option key={opt.value} value={opt.value}>
                    {opt.label}
                  </Select.Option>
                ))}
              </Select>
            </div>

            {/* Description */}
            <div className='flex flex-col gap-6px'>
              <span className='text-12px text-t-tertiary'>{t('studio.create.descriptionLabel')}</span>
              <TextArea
                value={description}
                onChange={setDescription}
                placeholder={t('studio.create.descriptionPlaceholder')}
                autoSize={{ minRows: 3, maxRows: 7 }}
              />
            </div>

            {/* References */}
            <div className='flex flex-col gap-8px'>
              <div className='flex items-center justify-between'>
                <span className='text-12px text-t-tertiary'>{t('studio.create.referencesLabel')}</span>
                <Button
                  type='text'
                  size='mini'
                  icon={<Paperclip theme='outline' size={14} />}
                  onClick={() => void handleAttach()}
                  disabled={references.length >= 5}
                >
                  {t('studio.create.attach')}
                </Button>
              </div>
              {references.length === 0 ? (
                <span className='text-12px text-t-quaternary'>{t('studio.create.referencesHint')}</span>
              ) : (
                <div className='flex flex-col gap-4px'>
                  {references.map((path) => (
                    <div key={path} className='flex items-center gap-8px rd-8px bg-fill-2 px-10px py-6px'>
                      <Paperclip theme='outline' size={13} className='text-t-tertiary shrink-0' />
                      <Tooltip content={path} mini>
                        <span className='flex-1 min-w-0 truncate text-12px text-t-secondary'>{baseName(path)}</span>
                      </Tooltip>
                      <Button
                        type='text'
                        size='mini'
                        aria-label={t('studio.create.removeReference')}
                        icon={<CloseSmall theme='outline' size={14} />}
                        onClick={() => removeReference(path)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className='m-0 text-13px text-t-secondary'>{t('studio.create.hint')}</p>
        )}

        {/* Footer */}
        <div className='flex items-center justify-end gap-8px pt-2px'>
          {busy ? (
            <span className='flex items-center gap-8px mr-auto text-12px text-t-tertiary'>
              <span className='size-6px rd-full bg-primary animate-pulse' />
              {progressLabel}
            </span>
          ) : null}
          <Button onClick={onCancel} disabled={busy}>
            {t('studio.create.cancel')}
          </Button>
          <Button
            type='primary'
            loading={busy}
            disabled={okDisabled}
            onClick={() => void handleCreate()}
            icon={effectiveMode === 'generate' ? <Lightning theme='outline' size={14} /> : undefined}
          >
            {effectiveMode === 'generate' ? t('studio.create.generateConfirm') : t('studio.create.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default CreateFileModal;
