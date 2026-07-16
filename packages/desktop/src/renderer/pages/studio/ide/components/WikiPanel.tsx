/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `WikiPanel` — the production-grade, persistent "Wiki" tab of the IDE.
 *
 * Opening the tab loads the previously-built wiki off disk (instant, no model).
 * "Generate" / "Regenerate" runs the durable pipeline in the Main process —
 * scan → VERIFY the docs against the real code (auto-fixing stale references) →
 * plan → author each section with a self-evaluate/improve loop → persist — while
 * a live status strip shows the current phase. When the build finishes the saved
 * wiki replaces the view: a left rail of sections, a "documentation check"
 * report (docs verified / corrected), a mean-quality badge, and the reading
 * column rendering each section as Markdown (Mermaid included).
 *
 * Generation state lives in {@link useRepoWiki}; this panel orchestrates the
 * model picker, build action, scroll-to-section, the evidence disclosure, and
 * the verification/quality surface.
 *
 * Renderer-only; all text via i18n; Arco + icon-park + UnoCSS tokens only.
 */

import { Button, Result, Select, Spin, Tag, Tooltip } from '@arco-design/web-react';
import { Book, CheckOne, FileCode, LoadingFour, Refresh, Right, Shield } from '@icon-park/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MarkdownView from '@renderer/components/Markdown';
import { useModelProviderList } from '@/renderer/hooks/agent/useModelProviderList';
import type { UseRepoWiki, WikiSectionState } from '../useRepoWiki';

const WIKI_MODEL_KEY = 'studio.ide.wikiModel';

type WikiPanelProps = {
  rootPath: string | null;
  wiki: UseRepoWiki;
};

/** Human title for a section: try the i18n title, else show the raw key. */
const useSectionTitle = (): ((key: string) => string) => {
  const { t } = useTranslation();
  return (key: string): string => {
    const full = `ide.wiki.section.${key}`;
    const translated = t(full);
    return translated === full ? key : translated;
  };
};

const WikiPanel: React.FC<WikiPanelProps> = ({ rootPath, wiki }) => {
  const { t, i18n } = useTranslation();
  const { providers, getAvailableModels } = useModelProviderList();
  const titleOf = useSectionTitle();
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: string[] = [];
    for (const provider of providers) {
      for (const model of getAvailableModels(provider)) {
        if (seen.has(model)) continue;
        seen.add(model);
        options.push(model);
      }
    }
    return options;
  }, [providers, getAvailableModels]);

  const [model, setModel] = useState<string | null>(() => localStorage.getItem(WIKI_MODEL_KEY));
  useEffect(() => {
    if (!model && modelOptions.length > 0) setModel(modelOptions[0]);
  }, [model, modelOptions]);

  // Auto-load the persisted wiki once per folder (instant; no model call).
  const { load } = wiki;
  const loadedRootRef = useRef<string | null>(null);
  useEffect(() => {
    if (!rootPath || loadedRootRef.current === rootPath) return;
    loadedRootRef.current = rootPath;
    if (wiki.status === 'building' || wiki.status === 'loading') return;
    void load(rootPath);
  }, [rootPath, load, wiki.status]);

  const handlePickModel = (value: string): void => {
    setModel(value);
    try {
      localStorage.setItem(WIKI_MODEL_KEY, value);
    } catch {
      /* storage unavailable — non-fatal */
    }
  };

  const busy = wiki.status === 'building' || wiki.status === 'loading';
  const handleGenerate = (): void => {
    if (!rootPath || !model || busy) return;
    void wiki.build(rootPath, model, i18n.language);
  };

  const scrollToSection = (id: string): void => {
    sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const hasWiki = wiki.sections.length > 0;

  // Idle / empty: invite the user to generate.
  if (wiki.status === 'idle' && !hasWiki) {
    return (
      <div className='size-full flex flex-col min-h-0'>
        <WikiToolbar
          model={model}
          modelOptions={modelOptions}
          busy={busy}
          canGenerate={Boolean(rootPath && model)}
          persisted={false}
          onPickModel={handlePickModel}
          onGenerate={handleGenerate}
          hasWiki={false}
        />
        <div className='flex-1 flex-center flex-col gap-12px px-24px text-center'>
          <span className='size-56px flex-center rd-16px bg-primary-light-1 text-primary'>
            <Book theme='outline' size={28} />
          </span>
          <p className='m-0 text-16px font-600 text-t-primary'>{t('ide.wiki.emptyTitle')}</p>
          <p className='m-0 max-w-420px text-13px text-t-secondary leading-relaxed'>{t('ide.wiki.emptyHint')}</p>
          <Button
            type='primary'
            className='mt-4px'
            disabled={!rootPath || !model}
            icon={<Book theme='outline' size={15} />}
            onClick={handleGenerate}
          >
            {t('ide.wiki.generate')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className='size-full flex flex-col min-h-0'>
      <WikiToolbar
        model={model}
        modelOptions={modelOptions}
        busy={busy}
        canGenerate={Boolean(rootPath && model)}
        persisted={wiki.persisted}
        onPickModel={handlePickModel}
        onGenerate={handleGenerate}
        hasWiki
      />
      {wiki.status === 'building' ? <WikiBuildStrip phase={wiki.phase} detail={wiki.phaseDetail} /> : null}
      <div className='flex-1 min-h-0 flex'>
        {/* Section nav */}
        <nav className='w-220px shrink-0 min-h-0 overflow-y-auto border-r border-b-1 p-10px flex flex-col gap-2px'>
          <span className='px-8px py-6px text-11px font-600 uppercase tracking-wide text-t-tertiary'>
            {t('ide.wiki.contents')}
          </span>
          {wiki.sections.map((section, i) => (
            <button
              key={section.plan.id}
              type='button'
              onClick={() => scrollToSection(section.plan.id)}
              className={`group h-34px shrink-0 w-full rd-8px flex items-center gap-8px px-10px cursor-pointer border-none bg-transparent text-left transition-colors hover:bg-fill-2 ${wiki.activeIndex === i ? 'bg-fill-2' : ''}`}
            >
              <SectionStatusDot status={section.status} />
              <span className='flex-1 truncate text-13px text-t-primary'>{titleOf(section.plan.titleKey)}</span>
              {typeof section.iterations === 'number' && section.iterations > 0 ? (
                <Tooltip content={t('ide.wiki.refinedTooltip', { count: section.iterations })}>
                  <span className='text-10px text-t-tertiary'>×{section.iterations}</span>
                </Tooltip>
              ) : null}
            </button>
          ))}
          {wiki.keyFiles.length > 0 ? <EvidenceList keyFiles={wiki.keyFiles} /> : null}
        </nav>

        {/* Reading column */}
        <div className='flex-1 min-w-0 min-h-0 overflow-y-auto'>
          {wiki.status === 'error' ? (
            <div className='h-full flex-center'>
              <Result status='warning' title={t('ide.wiki.buildFailed')} subTitle={wiki.error ?? ''}>
                <Button type='outline' icon={<Refresh theme='outline' size={14} />} onClick={handleGenerate}>
                  {t('ide.wiki.regenerate')}
                </Button>
              </Result>
            </div>
          ) : wiki.status === 'building' && !hasWiki ? (
            <div className='h-full flex-center flex-col gap-12px'>
              <Spin size={26} />
              <span className='text-13px text-t-secondary'>{t('ide.wiki.building')}</span>
            </div>
          ) : wiki.status === 'loading' ? (
            <div className='h-full flex-center flex-col gap-12px'>
              <Spin size={26} />
              <span className='text-13px text-t-secondary'>{t('ide.wiki.loadingSaved')}</span>
            </div>
          ) : (
            <article className='max-w-820px mx-auto px-32px py-28px flex flex-col gap-28px'>
              <WikiReport wiki={wiki} />
              {wiki.sections.map((section) => (
                <div
                  key={section.plan.id}
                  ref={(el) => {
                    sectionRefs.current[section.plan.id] = el;
                  }}
                  className='scroll-mt-16px'
                >
                  <h2 className='m-0 mb-12px pb-8px text-20px font-700 text-t-primary border-b border-b-1 flex items-center gap-10px'>
                    {titleOf(section.plan.titleKey)}
                  </h2>
                  <WikiSectionBody section={section} />
                </div>
              ))}
            </article>
          )}
        </div>
      </div>
    </div>
  );
};

/** Top toolbar: model picker + generate/regenerate + "saved" badge. */
const WikiToolbar: React.FC<{
  model: string | null;
  modelOptions: string[];
  busy: boolean;
  canGenerate: boolean;
  hasWiki: boolean;
  persisted: boolean;
  onPickModel: (value: string) => void;
  onGenerate: () => void;
}> = ({ model, modelOptions, busy, canGenerate, hasWiki, persisted, onPickModel, onGenerate }) => {
  const { t } = useTranslation();
  return (
    <div className='shrink-0 flex items-center gap-10px px-16px h-48px border-b border-b-1'>
      <span className='flex items-center gap-8px text-t-primary'>
        <Book theme='outline' size={16} className='text-primary' />
        <span className='text-13px font-600'>{t('ide.wiki.title')}</span>
      </span>
      {persisted && hasWiki ? (
        <Tag size='small' color='green' icon={<CheckOne theme='filled' size={11} />}>
          {t('ide.wiki.savedBadge')}
        </Tag>
      ) : null}
      <div className='flex-1' />
      <Select
        value={model ?? undefined}
        placeholder={t('ide.wiki.pickModel')}
        onChange={onPickModel}
        className='!w-200px'
        size='small'
        showSearch
      >
        {modelOptions.map((opt) => (
          <Select.Option key={opt} value={opt}>
            {opt}
          </Select.Option>
        ))}
      </Select>
      <Button
        type='primary'
        size='small'
        loading={busy}
        disabled={!canGenerate}
        icon={<Refresh theme='outline' size={14} />}
        onClick={onGenerate}
      >
        {hasWiki ? t('ide.wiki.regenerate') : t('ide.wiki.generate')}
      </Button>
    </div>
  );
};

/** Live build phase strip: spinner + phase label + detail (counts/quality). */
const WikiBuildStrip: React.FC<{ phase: UseRepoWiki['phase']; detail: string | null }> = ({ phase, detail }) => {
  const { t } = useTranslation();
  const label = phase ? t(`ide.wiki.phase_${phase}`) : t('ide.wiki.building');
  return (
    <div
      className='shrink-0 flex items-center gap-8px px-16px py-8px border-b border-b-1 bg-fill-1'
      role='status'
      aria-live='polite'
      data-testid='wiki-build-strip'
    >
      <LoadingFour theme='outline' size={14} className='text-primary animate-spin shrink-0' />
      <span className='text-12px font-600 text-t-primary'>{label}</span>
      {detail ? <span className='text-11px text-t-tertiary font-mono truncate'>{detail}</span> : null}
    </div>
  );
};

/** The "documentation check" + quality report shown atop a built wiki. */
const WikiReport: React.FC<{ wiki: UseRepoWiki }> = ({ wiki }) => {
  const { t, i18n } = useTranslation();
  const docCount = wiki.docReports.length;
  const fixedCount = wiki.docReports.reduce((sum, r) => sum + r.fixedCount, 0);
  const issueCount = wiki.docReports.reduce((sum, r) => sum + r.issueCount, 0);
  const builtWhen =
    wiki.builtAt != null
      ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(wiki.builtAt)
      : null;
  // Nothing useful to show (no docs checked + no quality + no timestamp).
  if (docCount === 0 && wiki.quality == null && !builtWhen) return null;
  return (
    <div className='flex flex-wrap items-center gap-8px px-12px py-10px rd-10px border border-b-1 bg-fill-1'>
      <Shield theme='outline' size={15} className='text-success shrink-0' />
      <span className='text-12px font-600 text-t-primary'>{t('ide.wiki.reportTitle')}</span>
      {docCount > 0 ? (
        <Tag size='small' color='arcoblue'>
          {t('ide.wiki.verifiedDocs', { count: docCount })}
        </Tag>
      ) : null}
      {docCount > 0 ? (
        <Tag size='small' color={fixedCount > 0 ? 'orange' : 'green'}>
          {fixedCount > 0 ? t('ide.wiki.docsFixed', { count: fixedCount }) : t('ide.wiki.docsClean')}
        </Tag>
      ) : null}
      {wiki.quality != null ? (
        <Tag size='small' color={wiki.quality >= 0.85 ? 'green' : wiki.quality >= 0.6 ? 'orange' : 'red'}>
          {t('ide.wiki.quality', { score: wiki.quality.toFixed(2) })}
        </Tag>
      ) : null}
      <div className='flex-1' />
      {builtWhen ? (
        <span className='text-11px text-t-tertiary'>{t('ide.wiki.savedAt', { when: builtWhen })}</span>
      ) : null}
      {issueCount > fixedCount ? (
        <span className='text-11px text-t-tertiary'>· {issueCount - fixedCount} flagged</span>
      ) : null}
    </div>
  );
};

/** Per-section status indicator dot. */
const SectionStatusDot: React.FC<{ status: WikiSectionState['status'] }> = ({ status }) => {
  if (status === 'done') return <CheckOne theme='filled' size={14} className='text-success shrink-0' />;
  if (status === 'writing')
    return <LoadingFour theme='outline' size={14} className='text-primary shrink-0 animate-spin' />;
  return <Right theme='outline' size={14} className='text-t-tertiary shrink-0' />;
};

/** A section's body: Markdown when present, else a short placeholder line. */
const WikiSectionBody: React.FC<{ section: WikiSectionState }> = ({ section }) => {
  const { t } = useTranslation();
  if (section.content.length === 0) {
    return <div className='text-12px text-t-tertiary py-4px'>{t('ide.wiki.sectionFailed')}</div>;
  }
  return (
    <div className='text-14px text-t-primary leading-relaxed'>
      <MarkdownView hiddenCodeCopyButton>{section.content}</MarkdownView>
    </div>
  );
};

/** Collapsible "evidence" list — the files the wiki was grounded on. */
const EvidenceList: React.FC<{ keyFiles: string[] }> = ({ keyFiles }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className='mt-8px pt-8px border-t border-b-1'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='h-30px w-full rd-8px flex items-center gap-6px px-8px cursor-pointer border-none bg-transparent hover:bg-fill-2 transition-colors'
      >
        <FileCode theme='outline' size={13} className='text-t-tertiary' />
        <span className='flex-1 text-12px text-t-secondary text-left'>
          {t('ide.wiki.evidence', { count: keyFiles.length })}
        </span>
        <Right
          theme='outline'
          size={12}
          className={`text-t-tertiary transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open ? (
        <div className='flex flex-col gap-3px px-8px pt-4px pb-2px'>
          {keyFiles.map((file) => (
            <span key={file} className='flex items-center gap-6px text-11px text-t-tertiary'>
              <span className='truncate' title={file}>
                {file}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default WikiPanel;
