/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Input, Message, Spin } from '@arco-design/web-react';
import { Delete, Plus, Save, SettingTwo } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CompanyLoadStatus } from '../useCompanyState';
import SectionCard from './SectionCard';

/** Compare two rule lists for value-equality (used to enable the Save button). */
const rulesEqual = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((rule, index) => rule === b[index]);

/**
 * View and edit a company's user-defined rules (criterion 3.10).
 *
 * Edits are kept in a local draft; Save commits the trimmed, non-empty list via
 * the `setRules` channel. Mirrors the {@link useCompanyState} load states so a
 * not-yet-wired backend degrades to a friendly error rather than crashing.
 */
const RulesEditor: React.FC<{
  rules: string[];
  status: CompanyLoadStatus;
  onSave: (rules: string[]) => Promise<boolean>;
}> = ({ rules, status, onSave }) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string[]>(rules);
  const [newRule, setNewRule] = useState('');
  const [saving, setSaving] = useState(false);

  // Re-sync the draft whenever the authoritative rules change.
  useEffect(() => {
    setDraft(rules);
  }, [rules]);

  const dirty = useMemo(() => !rulesEqual(draft, rules), [draft, rules]);

  const addRule = () => {
    const trimmed = newRule.trim();
    if (trimmed.length === 0) return;
    setDraft((prev) => [...prev, trimmed]);
    setNewRule('');
  };

  const updateRule = (index: number, value: string) => {
    setDraft((prev) => prev.map((rule, i) => (i === index ? value : rule)));
  };

  const removeRule = (index: number) => {
    setDraft((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const cleaned = draft.map((rule) => rule.trim()).filter((rule) => rule.length > 0);
      const ok = await onSave(cleaned);
      if (ok) Message.success(t('company.rules.saved'));
      else Message.error(t('company.rules.saveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      icon={<SettingTwo theme='outline' size='18' />}
      title={t('company.rules.title')}
      subtitle={t('company.rules.subtitle')}
      extra={
        <Button
          type='primary'
          size='small'
          icon={<Save theme='outline' size='14' />}
          loading={saving}
          disabled={!dirty}
          onClick={handleSave}
        >
          {t('company.rules.save')}
        </Button>
      }
    >
      {status === 'loading' && (
        <div className='flex-center py-32px'>
          <Spin size={24} />
        </div>
      )}

      {status === 'error' && <p className='m-0 text-13px text-t-secondary'>{t('company.rules.loadError')}</p>}

      {(status === 'ready' || status === 'idle') && (
        <div className='flex flex-col gap-12px'>
          {draft.length === 0 ? (
            <p className='m-0 text-13px text-t-tertiary'>{t('company.rules.empty')}</p>
          ) : (
            <ul className='m-0 p-0 list-none flex flex-col gap-8px'>
              {draft.map((rule, index) => (
                <li key={index} className='flex items-center gap-8px'>
                  <Input className='flex-1' value={rule} onChange={(value) => updateRule(index, value)} />
                  <Button
                    type='text'
                    size='small'
                    status='danger'
                    icon={<Delete theme='outline' size='14' />}
                    aria-label={t('company.rules.remove')}
                    onClick={() => removeRule(index)}
                  />
                </li>
              ))}
            </ul>
          )}

          <div className='flex items-center gap-8px'>
            <Input
              className='flex-1'
              value={newRule}
              allowClear
              placeholder={t('company.rules.addPlaceholder')}
              onChange={setNewRule}
              onPressEnter={addRule}
            />
            <Button icon={<Plus theme='outline' size='14' />} onClick={addRule}>
              {t('company.rules.add')}
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
};

export default RulesEditor;
