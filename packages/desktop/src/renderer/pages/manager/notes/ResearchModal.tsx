/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AI web-research modal for Learn notes (criterion 5.9, 5.10). The user enters a
 * topic; the system searches the web + synthesizes a study note, shown for
 * review/edit before saving. Degrades with a clear message when the model is
 * missing or search returns nothing.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, InputTag, Message, Modal } from '@arco-design/web-react';
import { Search } from '@icon-park/react';
import type { ResearchResult } from '@process/manager/managerTypes';
import type { UseManagerStore } from '../useManagerStore';

const { TextArea } = Input;

const ResearchModal: React.FC<{ store: UseManagerStore; onClose: (saved: boolean) => void }> = ({ store, onClose }) => {
  const { t } = useTranslation();
  const [topic, setTopic] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const runResearch = async () => {
    if (topic.trim().length === 0) {
      Message.warning(t('manager.notes.research.topicRequired'));
      return;
    }
    setLoading(true);
    try {
      const res = await store.client.aiResearch({ topic: topic.trim() });
      if (res.ok) {
        const data = res.data;
        // Append a sources section so links are preserved in the editable body.
        const sourcesMd =
          data.sources.length > 0
            ? `\n\n## ${t('manager.notes.research.sources')}\n` +
              data.sources.map((s) => `- [${s.title}](${s.url})`).join('\n')
            : '';
        setResult(data);
        setTitle(data.title);
        setBody(data.body + sourcesMd);
        setTags(data.tags);
        if (!data.webUsed) Message.info(t('manager.notes.research.webLimited'));
      } else if ((res as { code?: string }).code === 'no-model') {
        Message.warning(t('manager.notes.research.noModel'));
      } else {
        Message.error(t('manager.notes.research.failed'));
      }
    } catch {
      Message.error(t('manager.notes.research.failed'));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (body.trim().length === 0) {
      Message.warning(t('manager.notes.research.failed'));
      return;
    }
    setSaving(true);
    try {
      const ok = await store.run(() =>
        store.client.addNote({
          input: { category: 'learn', title: title || topic, body, tags, sources: result?.sources },
        })
      );
      if (ok) {
        Message.success(t('manager.notes.research.saved'));
        onClose(true);
      } else {
        Message.error(t('manager.notes.research.failed'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible
      title={t('manager.notes.research.title')}
      onCancel={() => onClose(false)}
      footer={
        <div className='flex justify-end gap-8px'>
          <Button onClick={() => onClose(false)}>{t('manager.notes.research.cancel')}</Button>
          {result ? (
            <Button type='primary' loading={saving} onClick={() => void save()}>
              {t('manager.notes.research.save')}
            </Button>
          ) : (
            <Button
              type='primary'
              loading={loading}
              icon={<Search theme='outline' size='14' />}
              onClick={() => void runResearch()}
            >
              {t('manager.notes.research.run')}
            </Button>
          )}
        </div>
      }
      style={{ width: 600 }}
    >
      {!result ? (
        <div className='flex flex-col gap-8px'>
          <div className='text-12px text-t-secondary'>{t('manager.notes.research.hint')}</div>
          <Input
            value={topic}
            onChange={setTopic}
            placeholder={t('manager.notes.research.topicPlaceholder')}
            onPressEnter={() => void runResearch()}
          />
        </div>
      ) : (
        <div className='flex flex-col gap-12px'>
          <div>
            <div className='text-12px text-t-secondary mb-4px'>{t('manager.notes.research.fieldTitle')}</div>
            <Input value={title} onChange={setTitle} />
          </div>
          <div>
            <div className='text-12px text-t-secondary mb-4px'>{t('manager.notes.research.fieldBody')}</div>
            <TextArea value={body} onChange={setBody} autoSize={{ minRows: 8, maxRows: 18 }} />
          </div>
          <div>
            <div className='text-12px text-t-secondary mb-4px'>{t('manager.notes.research.fieldTags')}</div>
            <InputTag value={tags} onChange={setTags} />
          </div>
        </div>
      )}
    </Modal>
  );
};

export default ResearchModal;
