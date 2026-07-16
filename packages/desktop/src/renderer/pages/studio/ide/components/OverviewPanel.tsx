/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `OverviewPanel` — the "teach me this codebase" landing view of the IDE
 * Understand mode. Following Understand-Anything's motto ("graphs that teach,
 * not graphs that impress"), this is what the user sees FIRST after a build:
 * a plain-English project overview, so they learn the shape of the codebase
 * before being dropped into a graph of nodes.
 *
 * It renders:
 *  - the project **tagline** + a Markdown **description** (the staff-engineer
 *    onboarding intro from the semantic pass),
 *  - **technology** chips,
 *  - **entry-point** files (clickable → opens that node in the graph),
 *  - a compact stat strip (files / deps / layers / externals).
 *
 * When the overview is missing (older graph, or the model omitted it), it falls
 * back to the stats so the view is never empty. Renderer-only; Arco +
 * icon-park + UnoCSS tokens; all text via i18n.
 */

import { Button, Tag } from '@arco-design/web-react';
import { Bookshelf, FileCode, Right, Rocket, Translate } from '@icon-park/react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import MarkdownView from '@renderer/components/Markdown';
import type { KnowledgeGraph } from '../ideClient';

type OverviewPanelProps = {
  graph: KnowledgeGraph;
  /** Open a node in the graph (entry point click). */
  onSelectNode: (id: string) => void;
  /** Jump to the graph view (e.g. after picking an entry point). */
  onOpenGraph: () => void;
  /** Rebuild the graph (used by the "regenerate in your language" hint). */
  onRebuild?: () => void;
};

/** Coarse language match: compare the leading subtag (e.g. `vi` === `vi-VN`). */
const sameLang = (a: string | undefined, b: string | undefined): boolean => {
  if (!a || !b) return true; // legacy graph w/o language → don't nag
  return a.toLowerCase().split('-')[0] === b.toLowerCase().split('-')[0];
};

/** Basename for a node id (entry points are shown by file name + path hint). */
const baseOf = (id: string): string => id.split('/').pop() ?? id;

const mermaidMarkdown = (code: string): string => ['```mermaid', code, '```'].join('\n');

const OverviewPanel: React.FC<OverviewPanelProps> = ({ graph, onSelectNode, onOpenGraph, onRebuild }) => {
  const { t, i18n } = useTranslation();
  const overview = graph.overview;
  const layerCount = useMemo(() => new Set(graph.nodes.map((n) => n.layer)).size, [graph.nodes]);
  const externalsCount = graph.externals?.length ?? 0;
  const langMismatch = !sameLang(graph.language, i18n.language);

  const openNode = (id: string): void => {
    onSelectNode(id);
    onOpenGraph();
  };

  return (
    <div className='size-full overflow-y-auto'>
      <div className='mx-auto max-w-880px px-28px py-24px flex flex-col gap-22px'>
        {/* Language mismatch hint: graph built in a different display language. */}
        {langMismatch && onRebuild ? (
          <Button
            type='text'
            onClick={onRebuild}
            className='!h-auto !flex !items-center !justify-start gap-8px !px-12px !py-9px rd-10px border border-primary-light-3 bg-primary-light-1 text-left transition-opacity hover:opacity-80'
          >
            <Translate theme='outline' size={15} className='shrink-0 text-primary' />
            <span className='text-12px text-t-secondary leading-snug'>{t('ide.understand.overview.langMismatch')}</span>
          </Button>
        ) : null}

        {/* Hero: tagline + description */}
        <section className='flex flex-col gap-12px'>
          <span className='flex items-center gap-8px text-11px font-600 uppercase tracking-wider text-t-tertiary'>
            <Rocket theme='outline' size={13} />
            {t('ide.understand.overview.eyebrow')}
          </span>
          <h1 className='m-0 text-22px font-700 text-t-primary leading-tight'>
            {overview?.tagline || t('ide.understand.overview.fallbackTagline')}
          </h1>
          {overview?.description ? (
            <div className='text-14px text-t-secondary leading-relaxed'>
              <MarkdownView hiddenCodeCopyButton>{overview.description}</MarkdownView>
            </div>
          ) : (
            <p className='m-0 text-13px text-t-tertiary leading-relaxed'>{t('ide.understand.overview.empty')}</p>
          )}
        </section>

        {/* Stat strip */}
        <section className='grid grid-cols-4 gap-10px'>
          <StatCell value={graph.fileCount} label={t('ide.understand.stats.files')} />
          <StatCell value={graph.edges.length} label={t('ide.understand.stats.deps')} />
          <StatCell value={layerCount} label={t('ide.understand.stats.layers')} />
          <StatCell value={externalsCount} label={t('ide.understand.stats.externals')} />
        </section>

        {/* Technologies */}
        {overview && overview.technologies.length > 0 ? (
          <Section icon={<Bookshelf theme='outline' size={14} />} title={t('ide.understand.overview.technologies')}>
            <div className='flex items-center gap-6px flex-wrap'>
              {overview.technologies.map((tech) => (
                <Tag key={tech} size='small' className='!text-11px !px-8px !py-3px bg-fill-2'>
                  {tech}
                </Tag>
              ))}
            </div>
          </Section>
        ) : null}

        {graph.runbook ? (
          <Section icon={<Rocket theme='outline' size={14} />} title={t('ide.understand.overview.runbook')}>
            <div className='flex flex-col gap-8px'>
              {graph.runbook.commands.length > 0 ? (
                <div className='flex flex-col gap-4px'>
                  {graph.runbook.commands.slice(0, 6).map((command) => (
                    <div
                      key={`${command.cwd}:${command.name}`}
                      className='flex items-center gap-8px px-10px py-7px rd-8px bg-fill-1 border border-arco-2'
                    >
                      <Tag size='small' className='!text-11px'>
                        {command.kind}
                      </Tag>
                      <span className='text-12px font-600 text-t-primary'>{command.command}</span>
                      <span className='ml-auto truncate text-11px text-t-tertiary'>{command.cwd}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className='flex items-center gap-6px flex-wrap'>
                {graph.runbook.packageManager ? (
                  <Tag size='small'>
                    {t('ide.understand.overview.packageManager', { name: graph.runbook.packageManager })}
                  </Tag>
                ) : null}
                {graph.runbook.ports.map((port) => (
                  <Tag key={port} size='small'>
                    {t('ide.understand.overview.port', { port })}
                  </Tag>
                ))}
                {graph.runbook.env.slice(0, 8).map((env) => (
                  <Tag key={env} size='small'>
                    {env}
                  </Tag>
                ))}
              </div>
            </div>
          </Section>
        ) : null}

        {graph.diagrams && graph.diagrams.length > 0 ? (
          <Section icon={<FileCode theme='outline' size={14} />} title={t('ide.understand.overview.diagrams')}>
            <div className='flex flex-col gap-14px'>
              {graph.diagrams.map((diagram) => (
                <div key={diagram.id} className='flex flex-col gap-6px'>
                  <div className='flex items-center gap-8px'>
                    <span className='text-13px font-600 text-t-primary'>{diagram.title}</span>
                    <Tag size='small'>{diagram.kind}</Tag>
                  </div>
                  <p className='m-0 text-12px text-t-tertiary'>{diagram.description}</p>
                  <MarkdownView hiddenCodeCopyButton>{mermaidMarkdown(diagram.mermaid)}</MarkdownView>
                </div>
              ))}
            </div>
          </Section>
        ) : null}

        {/* Entry points */}
        {overview && overview.entryPoints.length > 0 ? (
          <Section icon={<FileCode theme='outline' size={14} />} title={t('ide.understand.overview.entryPoints')}>
            <div className='flex flex-col gap-4px'>
              {overview.entryPoints.map((id) => (
                <Button
                  key={id}
                  type='text'
                  onClick={() => openNode(id)}
                  title={id}
                  className='group !h-auto !flex !items-center !justify-start gap-8px !px-10px !py-7px rd-8px border border-arco-2 bg-1 text-left transition-colors hover:bg-fill-2 hover:border-primary'
                >
                  <FileCode theme='outline' size={14} className='shrink-0 text-primary' />
                  <span className='shrink-0 text-13px font-600 text-t-primary'>{baseOf(id)}</span>
                  <span className='truncate text-11px text-t-tertiary'>{id}</span>
                  <Right
                    theme='outline'
                    size={13}
                    className='ml-auto shrink-0 text-t-tertiary opacity-0 group-hover:opacity-100 transition-opacity'
                  />
                </Button>
              ))}
            </div>
          </Section>
        ) : null}
      </div>
    </div>
  );
};

/** A titled section block. */
const Section: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode }> = ({
  icon,
  title,
  children,
}) => (
  <section className='flex flex-col gap-10px'>
    <span className='flex items-center gap-7px text-12px font-600 uppercase tracking-wide text-t-tertiary'>
      {icon}
      {title}
    </span>
    {children}
  </section>
);

/** A single stat tile. */
const StatCell: React.FC<{ value: number; label: string }> = ({ value, label }) => (
  <div className='flex flex-col items-center gap-2px px-8px py-12px rd-12px bg-fill-1 border border-arco-2'>
    <span className='text-20px font-700 text-t-primary leading-none'>{value}</span>
    <span className='text-10px text-t-tertiary text-center leading-tight'>{label}</span>
  </div>
);

export default OverviewPanel;
