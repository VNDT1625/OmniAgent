/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CompanyStructure } from '@process/company/companyOrchestrator';
import type { StructureDivisionInput } from '@process/company/companyBridge';
import { Button, InputNumber, Input, Modal, Message } from '@arco-design/web-react';
import { Delete, Plus } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Editable division row (local draft before save). */
type DraftDivision = StructureDivisionInput & { _key: string };

let keySeq = 0;
const nextKey = (): string => `d${++keySeq}`;

/** Derive editable divisions from the current structure (division heads + their worker counts). */
const fromStructure = (structure: CompanyStructure | null): DraftDivision[] => {
  if (!structure) return [];
  return structure.root.children
    .filter((n) => n.role === 'division-head')
    .map((head) => ({
      _key: nextKey(),
      divisionId: head.divisionId ?? '',
      name: head.name.replace(/\s+Lead$/, ''),
      headName: head.name,
      responsibilities: head.responsibilities,
      workerCount: head.children.filter((c) => c.role === 'worker').length,
    }));
};

/**
 * Modal to manually edit the company structure: president name + a list of
 * divisions (name, head name, responsibilities, worker count). Add/remove rows,
 * then save. Assignments for surviving divisions/workers are preserved by the
 * backend; this editor only changes the structural shape.
 */
const StructureEditor: React.FC<{
  visible: boolean;
  structure: CompanyStructure | null;
  onCancel: () => void;
  onSave: (input: { presidentName?: string; divisions: StructureDivisionInput[] }) => Promise<boolean>;
}> = ({ visible, structure, onCancel, onSave }) => {
  const { t } = useTranslation();
  const [presidentName, setPresidentName] = useState('');
  const [divisions, setDivisions] = useState<DraftDivision[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setPresidentName(structure?.root.name ?? '');
    setDivisions(fromStructure(structure));
  }, [visible, structure]);

  const updateRow = (key: string, patch: Partial<DraftDivision>) => {
    setDivisions((prev) => prev.map((d) => (d._key === key ? { ...d, ...patch } : d)));
  };

  const addRow = () => {
    setDivisions((prev) => [...prev, { _key: nextKey(), divisionId: '', name: '', workerCount: 1 }]);
  };

  const removeRow = (key: string) => {
    setDivisions((prev) => prev.filter((d) => d._key !== key));
  };

  const handleSave = async () => {
    const cleaned = divisions
      .map((d) => ({
        divisionId: (d.divisionId || d.name).trim(),
        name: d.name.trim(),
        headName: d.headName?.trim() || undefined,
        responsibilities: d.responsibilities?.trim() || undefined,
        workerCount: Math.max(0, Math.floor(d.workerCount || 0)),
      }))
      .filter((d) => d.name.length > 0);

    setSaving(true);
    try {
      const ok = await onSave({ presidentName: presidentName.trim() || undefined, divisions: cleaned });
      if (ok) {
        Message.success(t('company.editor.saved'));
        onCancel();
      } else {
        Message.error(t('company.editor.saveError'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible={visible}
      title={t('company.editor.title')}
      onCancel={onCancel}
      onOk={() => void handleSave()}
      confirmLoading={saving}
      okText={t('company.editor.save')}
      cancelText={t('common.cancel')}
      style={{ width: 640 }}
      autoFocus={false}
      unmountOnExit
    >
      <div className='flex flex-col gap-16px py-4px'>
        <div className='flex flex-col gap-6px'>
          <span className='text-13px font-500 text-t-primary'>{t('company.editor.presidentName')}</span>
          <Input
            value={presidentName}
            onChange={setPresidentName}
            placeholder={t('company.editor.presidentName')}
            allowClear
          />
        </div>

        <div className='flex items-center justify-between'>
          <span className='text-13px font-500 text-t-primary'>{t('company.editor.divisions')}</span>
          <Button size='small' icon={<Plus theme='outline' size='14' />} onClick={addRow}>
            {t('company.editor.addDivision')}
          </Button>
        </div>

        <div className='flex flex-col gap-12px max-h-360px overflow-y-auto'>
          {divisions.length === 0 ? (
            <p className='m-0 text-12px text-t-tertiary'>{t('company.editor.noDivisions')}</p>
          ) : (
            divisions.map((d) => (
              <div
                key={d._key}
                className='flex flex-col gap-8px p-12px rd-12px bg-fill-1 border border-solid border-border-2'
              >
                <div className='flex items-center gap-8px'>
                  <Input
                    value={d.name}
                    onChange={(v) => updateRow(d._key, { name: v })}
                    placeholder={t('company.editor.divisionName')}
                    className='flex-1'
                  />
                  <InputNumber
                    value={d.workerCount}
                    onChange={(v) => updateRow(d._key, { workerCount: typeof v === 'number' ? v : 0 })}
                    min={0}
                    max={50}
                    step={1}
                    style={{ width: 110 }}
                    suffix={t('company.editor.workersSuffix')}
                  />
                  <Button
                    type='text'
                    status='danger'
                    size='small'
                    icon={<Delete theme='outline' size='14' />}
                    onClick={() => removeRow(d._key)}
                  />
                </div>
                <Input
                  value={d.headName}
                  onChange={(v) => updateRow(d._key, { headName: v })}
                  placeholder={t('company.editor.headName')}
                  allowClear
                />
                <Input.TextArea
                  value={d.responsibilities}
                  onChange={(v) => updateRow(d._key, { responsibilities: v })}
                  placeholder={t('company.editor.responsibilities')}
                  autoSize={{ minRows: 1, maxRows: 3 }}
                />
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
};

export default StructureEditor;
