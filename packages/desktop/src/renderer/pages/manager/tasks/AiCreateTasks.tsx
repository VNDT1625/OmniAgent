/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AI task creation (Requirement 2): the user describes work in free text, the
 * model proposes structured tasks, and a review modal lets them accept all,
 * accept some, or cancel before anything is saved (criterion 2.2, 2.3). Errors
 * (no model / bad reply) are shown inline and the input is preserved
 * (criterion 2.5).
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Message } from '@arco-design/web-react';
import { MagicWand } from '@icon-park/react';
import type { TaskProposal } from '@process/manager/managerAi';
import type { UseManagerStore } from '../useManagerStore';
import DraftReview from './DraftReview';

const { TextArea } = Input;

const AiCreateTasks: React.FC<{ store: UseManagerStore }> = ({ store }) => {
  const { t } = useTranslation();
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [drafts, setDrafts] = useState<TaskProposal[] | null>(null);

  const handleCreate = async () => {
    const text = description.trim();
    if (text.length === 0) {
      Message.warning(t('manager.tasks.aiEmpty'));
      return;
    }
    setLoading(true);
    try {
      const result = await store.client.aiParseTasks({ description: text });
      if (result.ok) {
        if (result.data.length === 0) {
          Message.info(t('manager.tasks.aiNoTasks'));
          return;
        }
        setDrafts(result.data);
      } else if ((result as { code?: string }).code === 'no-model') {
        Message.warning(t('manager.tasks.aiConfigureModel'));
      } else {
        Message.error(t('manager.tasks.aiFailed'));
      }
    } catch {
      Message.error(t('manager.tasks.aiFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className='rd-10px border border-dashed border-arco-2 bg-fill-1 p-10px'>
      <div className='flex items-start gap-8px'>
        <TextArea
          value={description}
          onChange={setDescription}
          placeholder={t('manager.tasks.aiPlaceholder')}
          autoSize={{ minRows: 1, maxRows: 4 }}
          className='flex-1'
          style={{ background: 'transparent', border: 'none', boxShadow: 'none' }}
        />
        <Button
          type='primary'
          loading={loading}
          icon={<MagicWand theme='outline' size='14' />}
          onClick={() => void handleCreate()}
        >
          {t('manager.tasks.aiCreate')}
        </Button>
      </div>

      {drafts && (
        <DraftReview
          store={store}
          drafts={drafts}
          onClose={(savedCount) => {
            setDrafts(null);
            if (savedCount > 0) setDescription('');
          }}
        />
      )}
    </div>
  );
};

export default AiCreateTasks;
