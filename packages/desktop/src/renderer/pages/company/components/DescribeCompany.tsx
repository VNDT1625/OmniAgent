/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Input, Message } from '@arco-design/web-react';
import { MagicHat } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CreateOutcome } from '../useCompanyState';
import { DEFAULT_COMPANY_ID, isValidCompanyId } from '../constants';
import GenerationProgress from './GenerationProgress';
import SectionCard from './SectionCard';

/**
 * Create a company from a free-text description (criterion 3.11).
 *
 * The generation runs in the background store (generationStore.ts) so it
 * survives tab switches — the user can navigate away and come back to see the
 * progress bar still running and the result when it finishes.
 *
 * `generationRunning` and `generationStartedAt` come from the parent
 * (useCompanyState → generationStore) so they reflect the true background state,
 * not a local component flag that resets on unmount.
 */
const DescribeCompany: React.FC<{
  onCreate: (companyId: string, description: string) => Promise<CreateOutcome>;
  strengthsGuidance: string;
  onChangeStrengthsGuidance: (guidance: string) => void;
  /** Whether a generation is currently running (from the background store). */
  generationRunning?: boolean;
  /** When the current generation started (Unix ms), for the elapsed timer. */
  generationStartedAt?: number;
}> = ({ onCreate, strengthsGuidance, onChangeStrengthsGuidance, generationRunning = false, generationStartedAt }) => {
  const { t } = useTranslation();
  const [companyId, setCompanyId] = useState('');
  const [description, setDescription] = useState('');
  // `done` is a brief flash (100% bar) after the generation finishes.
  const [done, setDone] = useState(false);

  // When the background generation finishes (generationRunning flips false),
  // flash the "done" state for a moment so the bar snaps to 100%.
  const [wasRunning, setWasRunning] = useState(generationRunning);
  useEffect(() => {
    if (wasRunning && !generationRunning) {
      setDone(true);
      const t = setTimeout(() => setDone(false), 500);
      return () => clearTimeout(t);
    }
    setWasRunning(generationRunning);
    return undefined;
  }, [generationRunning, wasRunning]);

  const handleSubmit = async () => {
    const trimmedDescription = description.trim();
    if (trimmedDescription.length === 0) {
      Message.warning(t('company.describe.emptyInput'));
      return;
    }
    const trimmedId = companyId.trim();
    const effectiveId = trimmedId.length > 0 ? trimmedId : DEFAULT_COMPANY_ID;
    if (!isValidCompanyId(effectiveId)) {
      Message.warning(t('company.picker.addError'));
      return;
    }

    // The actual call is delegated to the background store via onCreate.
    // We don't await it here — the store drives the state; we just fire and
    // let the progress bar (driven by generationRunning) show the status.
    void onCreate(effectiveId, trimmedDescription).then((outcome) => {
      if (outcome.ok) {
        Message.success(t('company.describe.success'));
        setDescription('');
        setCompanyId('');
      } else if (outcome.reason === 'notWired') {
        Message.info(outcome.message || t('company.describe.notWired'));
      } else {
        Message.error(outcome.message || t('company.describe.error'));
      }
    });
  };

  const submitting = generationRunning;

  return (
    <SectionCard
      icon={<MagicHat theme='outline' size='18' />}
      title={t('company.describe.title')}
      subtitle={t('company.describe.subtitle')}
    >
      <div className='flex flex-col gap-12px'>
        <Input
          addBefore={t('company.describe.idLabel')}
          value={companyId}
          allowClear
          placeholder={t('company.describe.idPlaceholder')}
          onChange={setCompanyId}
          disabled={submitting}
        />
        <Input.TextArea
          value={description}
          placeholder={t('company.describe.placeholder')}
          autoSize={{ minRows: 4, maxRows: 10 }}
          disabled={submitting}
          onChange={setDescription}
        />
        <div className='flex flex-col gap-4px'>
          <span className='text-12px text-t-tertiary'>{t('company.describe.strengthsLabel')}</span>
          <Input.TextArea
            value={strengthsGuidance}
            placeholder={t('company.describe.strengthsPlaceholder')}
            autoSize={{ minRows: 2, maxRows: 6 }}
            disabled={submitting}
            onChange={onChangeStrengthsGuidance}
          />
        </div>
        <GenerationProgress active={submitting} done={done} startedAt={generationStartedAt} />
        {submitting && <span className='text-11px text-t-tertiary'>{t('company.describe.tabSwitchHint')}</span>}
        <div className='flex justify-end'>
          <Button
            type='primary'
            icon={<MagicHat theme='outline' size='14' />}
            loading={submitting}
            onClick={handleSubmit}
          >
            {submitting ? t('company.describe.submitting') : t('company.describe.submit')}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
};

export default DescribeCompany;
