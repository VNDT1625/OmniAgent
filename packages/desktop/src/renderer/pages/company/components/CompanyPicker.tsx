/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Input, Message, Popconfirm, Tag } from '@arco-design/web-react';
import { BuildingTwo, Delete, Plus } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isValidCompanyId } from '../constants';
import SectionCard from './SectionCard';

/**
 * Company roster (criterion 3.1 — list/create companies).
 *
 * Lists the company ids the user has worked with, lets them switch the active
 * company, add a new one by id, or forget one from the local roster. The bridge
 * exposes no "list" channel, so this roster is the renderer's own (persisted in
 * `localStorage` by {@link useCompanyState}).
 */
const CompanyPicker: React.FC<{
  knownIds: string[];
  activeId: string | null;
  onSelect: (companyId: string) => void;
  onAdd: (companyId: string) => void;
  onForget: (companyId: string) => void | Promise<boolean>;
}> = ({ knownIds, activeId, onSelect, onAdd, onForget }) => {
  const { t } = useTranslation();
  const [draftId, setDraftId] = useState('');

  const handleDelete = async (id: string) => {
    const result = await Promise.resolve(onForget(id));
    // `onForget` resolves to whether the on-disk delete succeeded. `false` here
    // means the roster id was removed but the disk folder might still exist
    // (e.g. the bridge was unavailable) — tell the user honestly.
    if (result === false) {
      Message.warning(t('company.picker.deletePartial', { companyId: id }));
    } else {
      Message.success(t('company.picker.deleteDone', { companyId: id }));
    }
  };

  const handleAdd = () => {
    const trimmed = draftId.trim();
    if (!isValidCompanyId(trimmed)) {
      Message.warning(t('company.picker.addError'));
      return;
    }
    onAdd(trimmed);
    setDraftId('');
  };

  return (
    <SectionCard
      icon={<BuildingTwo theme='outline' size='18' />}
      title={t('company.picker.title')}
      subtitle={t('company.picker.subtitle')}
    >
      <div className='flex flex-col gap-12px'>
        <div className='flex items-center gap-8px'>
          <Input
            className='flex-1'
            value={draftId}
            allowClear
            placeholder={t('company.picker.idPlaceholder')}
            onChange={setDraftId}
            onPressEnter={handleAdd}
          />
          <Button type='primary' icon={<Plus theme='outline' size='14' />} onClick={handleAdd}>
            {t('company.picker.add')}
          </Button>
        </div>

        {knownIds.length === 0 ? (
          <p className='m-0 text-13px text-t-tertiary'>{t('company.picker.empty')}</p>
        ) : (
          <ul className='m-0 p-0 list-none flex flex-col gap-6px'>
            {knownIds.map((id) => {
              const active = id === activeId;
              return (
                <li
                  key={id}
                  className={`flex items-center justify-between gap-8px px-12px py-8px rd-10px transition-colors cursor-pointer ${active ? '!bg-fill-3' : 'bg-fill-1 hover:bg-fill-2'}`}
                  onClick={() => onSelect(id)}
                >
                  <span className='flex items-center gap-8px min-w-0'>
                    <BuildingTwo theme='outline' size='15' className='shrink-0 text-t-secondary' />
                    <span className='text-13px text-t-primary truncate'>{id}</span>
                    {active && (
                      <Tag size='small' color='arcoblue'>
                        {t('company.picker.active')}
                      </Tag>
                    )}
                  </span>
                  <Popconfirm
                    title={t('company.picker.deleteConfirmTitle')}
                    content={t('company.picker.deleteConfirmContent', { companyId: id })}
                    okText={t('company.picker.deleteConfirmOk')}
                    cancelText={t('company.picker.deleteConfirmCancel')}
                    position='lt'
                    onOk={() => void handleDelete(id)}
                  >
                    <Button
                      type='text'
                      size='mini'
                      status='danger'
                      icon={<Delete theme='outline' size='14' />}
                      aria-label={t('company.picker.delete')}
                      onClick={(event) => event.stopPropagation()}
                    />
                  </Popconfirm>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </SectionCard>
  );
};

export default CompanyPicker;
