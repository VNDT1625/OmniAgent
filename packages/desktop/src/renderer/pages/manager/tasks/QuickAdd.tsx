/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `QuickAdd` — a single-line natural-language task entry (Todoist-class). The
 * user types e.g. `Nộp báo cáo mai 5pm !cao #work` and presses Enter; the line
 * is parsed instantly by {@link parseQuickTask} (no AI) into a structured task
 * and saved. A live chip preview shows the detected due date, priority and tags
 * so the user trusts what will be created.
 *
 * Renderer-only. Arco + UnoCSS + i18n.
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input, Message, Tag } from '@arco-design/web-react';
import { Calendar, Flag } from '@icon-park/react';
import type { UseManagerStore } from '../useManagerStore';
import { priorityColor, priorityKey } from '../managerStrings';
import { parseQuickTask } from './quickAddParser';

const QuickAdd: React.FC<{ store: UseManagerStore }> = ({ store }) => {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const preview = useMemo(() => (text.trim().length > 0 ? parseQuickTask(text) : null), [text]);

  const dueLabel = useMemo(() => {
    if (!preview?.dueAt) return null;
    return new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(preview.dueAt);
  }, [preview, i18n.language]);

  const submit = async () => {
    const parsed = parseQuickTask(text);
    if (parsed.title.length === 0) {
      Message.warning(t('manager.quickAdd.empty'));
      return;
    }
    setSaving(true);
    try {
      const ok = await store.run(() =>
        store.client.addTask({
          input: {
            title: parsed.title,
            priority: parsed.priority,
            dueAt: parsed.dueAt,
            tags: parsed.tags,
            reminders: parsed.dueAt ? [{ fireAt: parsed.dueAt }] : undefined,
          },
        })
      );
      if (ok) {
        setText('');
        Message.success(t('manager.quickAdd.added'));
      } else {
        Message.error(t('manager.quickAdd.failed'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className='flex flex-col gap-6px'>
      <Input
        value={text}
        onChange={setText}
        onPressEnter={() => void submit()}
        disabled={saving}
        size='large'
        allowClear
        prefix={<span className='text-t-tertiary text-16px'>+</span>}
        placeholder={t('manager.quickAdd.placeholder')}
        style={{ borderColor: 'var(--mgr-accent-light-2)' }}
      />
      {preview && (preview.dueAt || preview.priority || preview.tags.length > 0) && (
        <div className='flex items-center gap-6px flex-wrap px-2px'>
          {preview.priority && (
            <Tag size='small' color={priorityColor(preview.priority)} icon={<Flag theme='outline' size='11' />}>
              {t(priorityKey(preview.priority))}
            </Tag>
          )}
          {dueLabel && (
            <Tag size='small' icon={<Calendar theme='outline' size='11' />}>
              {dueLabel}
            </Tag>
          )}
          {preview.tags.map((tag) => (
            <span key={tag} className='text-11px text-t-secondary'>
              #{tag}
            </span>
          ))}
        </div>
      )}
      <div className='text-11px text-t-tertiary px-2px'>{t('manager.quickAdd.hint')}</div>
    </div>
  );
};

export default QuickAdd;
