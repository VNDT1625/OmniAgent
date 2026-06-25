/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `MemorySessionDrawer` — a live view of one IDE chat tab's EPHEMERAL session
 * super-memory. Opened from the chat tab strip, it lets the user watch what the
 * agent has chosen to remember this session: a token-budget gauge, compaction /
 * dedup / recall counters, the notes themselves (summaries, pinned, recent), and
 * the names of any session secrets (values are never shown). A "Clear" action
 * wipes the whole session.
 *
 * Aesthetic: refined minimalism with a single neural accent — a calm gauge, a
 * tight stat row, and quietly-tagged note rows. All colour comes from semantic
 * tokens / Arco named colours (no hardcoded hex); all text from i18n; light and
 * dark themes both honoured; respects reduced motion (transitions only).
 *
 * Renderer-only; Arco + @icon-park/react + UnoCSS tokens.
 */

import { Button, Drawer, Empty, Popconfirm, Progress, Spin, Tag, Tooltip } from '@arco-design/web-react';
import { Brain, Delete, Lock, Pin, Refresh } from '@icon-park/react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SuperMemoryItem, SuperMemoryKind } from '../ideClient';
import { useIdeMemory } from './useIdeMemory';

type MemorySessionDrawerProps = {
  /** Session-memory id of the active chat tab, or null when no tab is active. */
  memId: string | null;
  /** Whether the drawer is open (also gates polling). */
  visible: boolean;
  /** Close handler. */
  onClose: () => void;
};

/** Arco named-colour (theme token) per note kind — never a raw hex value. */
const KIND_COLOR: Record<SuperMemoryKind, string> = {
  fact: 'arcoblue',
  decision: 'purple',
  todo: 'orange',
  snippet: 'cyan',
  note: 'gray',
  summary: 'green',
};

/** Progress status driven by how full the budget is (themed, not hardcoded). */
const usageStatus = (pct: number): 'normal' | 'warning' | 'error' => (pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'normal');

/** One small labelled stat chip. */
const Stat: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className='flex flex-col items-center gap-2px px-10px py-6px rd-8px bg-fill-1 min-w-56px'>
    <span className='text-15px font-700 text-t-primary leading-none'>{value}</span>
    <span className='text-10px font-500 uppercase tracking-wide text-t-tertiary'>{label}</span>
  </div>
);

/** One note row: kind tag + (pin) + text. */
const NoteRow: React.FC<{ item: SuperMemoryItem; kindLabel: string; pinnedLabel: string }> = ({ item, kindLabel, pinnedLabel }) => (
  <div className='flex items-start gap-8px px-10px py-8px rd-8px bg-2 border border-arco-2 hover:border-primary transition-colors'>
    <Tag color={KIND_COLOR[item.kind]} size='small' className='shrink-0 mt-1px'>
      {kindLabel}
    </Tag>
    {item.pinned ? (
      <Tooltip content={pinnedLabel} mini>
        <Pin theme='filled' size={13} className='shrink-0 mt-3px text-warning' />
      </Tooltip>
    ) : null}
    <span className='flex-1 min-w-0 text-13px text-t-primary leading-relaxed break-words'>{item.text}</span>
  </div>
);

/**
 * The session-memory drawer. Polls a snapshot while open and renders it as a
 * gauge + stats + grouped note list + secret-key tags.
 */
const MemorySessionDrawer: React.FC<MemorySessionDrawerProps> = ({ memId, visible, onClose }) => {
  const { t } = useTranslation();
  const { snapshot, loading, refresh, clear } = useIdeMemory(memId, visible);

  const groups = useMemo(() => {
    const items = snapshot?.items ?? [];
    return {
      summaries: items.filter((i) => i.kind === 'summary'),
      pinned: items.filter((i) => i.pinned && i.kind !== 'summary'),
      recent: items.filter((i) => !i.pinned && i.kind !== 'summary'),
    };
  }, [snapshot]);

  const pct = useMemo(() => {
    if (!snapshot || snapshot.tokenBudget <= 0) return 0;
    return Math.min(100, Math.round((snapshot.tokensUsed / snapshot.tokenBudget) * 100));
  }, [snapshot]);

  const kindLabels = useMemo<Record<SuperMemoryKind, string>>(
    () => ({
      fact: t('ide.memory.kind.fact'),
      decision: t('ide.memory.kind.decision'),
      todo: t('ide.memory.kind.todo'),
      snippet: t('ide.memory.kind.snippet'),
      note: t('ide.memory.kind.note'),
      summary: t('ide.memory.kind.summary'),
    }),
    [t]
  );
  const kindLabel = (kind: SuperMemoryKind): string => kindLabels[kind];
  const isEmpty = !snapshot || snapshot.items.length === 0;

  return (
    <Drawer
      width={420}
      visible={visible}
      onCancel={onClose}
      footer={null}
      title={
        <div className='flex items-center gap-8px'>
          <span className='flex-center size-26px rd-8px bg-primary-light-1 text-primary'>
            <Brain theme='outline' size={16} />
          </span>
          <div className='flex flex-col'>
            <span className='text-14px font-600 text-t-primary leading-tight'>{t('ide.memory.title')}</span>
            <span className='text-11px text-t-tertiary leading-tight'>{t('ide.memory.subtitle')}</span>
          </div>
        </div>
      }
    >
      {!memId ? (
        <div className='size-full flex-center'>
          <Empty description={t('ide.memory.noSession')} />
        </div>
      ) : (
        <div className='flex flex-col gap-16px h-full min-h-0'>
          {/* Token-budget gauge */}
          <div className='flex flex-col gap-6px'>
            <div className='flex items-center justify-between'>
              <span className='text-11px font-600 uppercase tracking-wide text-t-tertiary'>{t('ide.memory.usage')}</span>
              <span className='text-12px font-500 text-t-secondary'>
                {t('ide.memory.usageValue', { used: snapshot?.tokensUsed ?? 0, budget: snapshot?.tokenBudget ?? 0 })}
              </span>
            </div>
            <Progress percent={pct} status={usageStatus(pct)} showText={false} strokeWidth={8} />
          </div>

          {/* Stat row */}
          <div className='flex flex-wrap gap-6px'>
            <Stat label={t('ide.memory.notes')} value={groups.recent.length + groups.pinned.length} />
            <Stat label={t('ide.memory.summaries')} value={groups.summaries.length} />
            <Stat label={t('ide.memory.pinned')} value={groups.pinned.length} />
            <Stat label={t('ide.memory.deduped')} value={snapshot?.deduped ?? 0} />
            <Stat label={t('ide.memory.recalls')} value={snapshot?.recalls ?? 0} />
            <Stat label={t('ide.memory.compactions')} value={snapshot?.compactions ?? 0} />
          </div>

          {/* Notes */}
          <div className='flex-1 min-h-0 overflow-y-auto flex flex-col gap-12px pr-2px'>
            {isEmpty ? (
              <div className='py-24px flex-center'>
                <Empty description={t('ide.memory.empty')} />
              </div>
            ) : (
              <>
                {groups.summaries.length > 0 ? (
                  <Section title={t('ide.memory.summaries')}>
                    {groups.summaries.map((item) => (
                      <NoteRow key={item.id} item={item} kindLabel={kindLabel(item.kind)} pinnedLabel={t('ide.memory.pinnedTag')} />
                    ))}
                  </Section>
                ) : null}
                {groups.pinned.length > 0 ? (
                  <Section title={t('ide.memory.pinned')}>
                    {groups.pinned.map((item) => (
                      <NoteRow key={item.id} item={item} kindLabel={kindLabel(item.kind)} pinnedLabel={t('ide.memory.pinnedTag')} />
                    ))}
                  </Section>
                ) : null}
                {groups.recent.length > 0 ? (
                  <Section title={t('ide.memory.notes')}>
                    {groups.recent.map((item) => (
                      <NoteRow key={item.id} item={item} kindLabel={kindLabel(item.kind)} pinnedLabel={t('ide.memory.pinnedTag')} />
                    ))}
                  </Section>
                ) : null}
              </>
            )}
          </div>

          {/* Secret keys */}
          <div className='flex flex-col gap-6px'>
            <div className='flex items-center gap-6px'>
              <Lock theme='outline' size={13} className='text-t-tertiary' />
              <span className='text-11px font-600 uppercase tracking-wide text-t-tertiary'>{t('ide.memory.secretKeys')}</span>
            </div>
            {snapshot && snapshot.secretKeys.length > 0 ? (
              <div className='flex flex-wrap gap-6px'>
                {snapshot.secretKeys.map((key) => (
                  <Tag key={key} size='small' bordered icon={<Lock theme='outline' size={11} />}>
                    {key}
                  </Tag>
                ))}
              </div>
            ) : (
              <span className='text-12px text-t-tertiary'>{t('ide.memory.noSecrets')}</span>
            )}
            <span className='text-11px text-t-tertiary leading-relaxed'>{t('ide.memory.secretsHint')}</span>
          </div>

          {/* Actions */}
          <div className='shrink-0 flex items-center justify-between gap-8px pt-8px border-t border-t-1'>
            <Button size='small' icon={loading ? <Spin size={12} /> : <Refresh theme='outline' size={14} />} onClick={() => void refresh()}>
              {t('ide.memory.refresh')}
            </Button>
            <Popconfirm focusLock title={t('ide.memory.clearConfirm')} onOk={() => void clear()}>
              <Button size='small' status='danger' icon={<Delete theme='outline' size={14} />} disabled={isEmpty}>
                {t('ide.memory.clear')}
              </Button>
            </Popconfirm>
          </div>
        </div>
      )}
    </Drawer>
  );
};

/** A small titled group of note rows. */
const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className='flex flex-col gap-6px'>
    <span className='text-11px font-600 uppercase tracking-wide text-t-tertiary'>{title}</span>
    <div className='flex flex-col gap-6px'>{children}</div>
  </div>
);

export default MemorySessionDrawer;
