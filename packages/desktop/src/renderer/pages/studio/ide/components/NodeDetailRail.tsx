/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `NodeDetailRail` — the right-hand detail rail of the IDE Understand graph.
 * Shows the selected file node's summary (badged LLM vs deterministic fallback
 * so the user knows the provenance), tags, and declared symbols; or, when
 * nothing is selected, a short hint + the graph stats.
 *
 * Split out of `UnderstandPanel` so the panel stays focused on orchestration.
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { Tag, Tooltip } from '@arco-design/web-react';
import { Code, Label, Lightning, Search } from '@icon-park/react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { LAYER_COLORS } from './layerColors';
import type { CodeSymbol } from '@process/ide/understandTypes';
import type { KnowledgeGraph, KnowledgeNode } from '../ideClient';

type NodeDetailRailProps = {
  graph: KnowledgeGraph;
  node: KnowledgeNode | null;
};

/** Right rail: the detail card for the selected node, or graph stats. */
const NodeDetailRail: React.FC<NodeDetailRailProps> = ({ graph, node }) => (
  <aside className='w-320px shrink-0 min-h-0 overflow-y-auto border-l border-b-1 bg-2'>
    {node ? <NodeDetail node={node} /> : <DetailHint graph={graph} />}
  </aside>
);

/** Empty detail state: a short hint plus the graph stats. */
const DetailHint: React.FC<{ graph: KnowledgeGraph }> = ({ graph }) => {
  const { t } = useTranslation();
  const layerCount = useMemo(() => new Set(graph.nodes.map((n) => n.layer)).size, [graph.nodes]);
  return (
    <div className='p-16px flex flex-col gap-16px'>
      <div className='flex flex-col items-center gap-10px py-20px text-center'>
        <span className='size-44px flex-center rd-full bg-fill-2 text-primary'>
          <Search theme='outline' size={22} />
        </span>
        <p className='m-0 text-13px text-t-secondary leading-relaxed max-w-220px'>
          {t('ide.understand.detail.selectHint')}
        </p>
      </div>
      <div className='grid grid-cols-3 gap-8px'>
        <StatCell value={graph.fileCount} label={t('ide.understand.stats.files')} />
        <StatCell value={graph.edges.length} label={t('ide.understand.stats.deps')} />
        <StatCell value={layerCount} label={t('ide.understand.stats.layers')} />
      </div>
      {graph.truncated ? (
        <p className='m-0 px-2px text-11px text-warning leading-relaxed'>{t('ide.understand.stats.truncated')}</p>
      ) : null}
    </div>
  );
};

/** A single stat tile. */
const StatCell: React.FC<{ value: number; label: string }> = ({ value, label }) => (
  <div className='flex flex-col items-center gap-2px px-6px py-10px rd-10px bg-fill-1 border border-arco-2'>
    <span className='text-18px font-700 text-t-primary leading-none'>{value}</span>
    <span className='text-10px text-t-tertiary text-center leading-tight'>{label}</span>
  </div>
);

/** The full detail card for a selected node. */
const NodeDetail: React.FC<{ node: KnowledgeNode }> = ({ node }) => {
  const { t } = useTranslation();
  return (
    <div className='p-16px flex flex-col gap-14px'>
      <div className='flex flex-col gap-8px'>
        <div className='flex items-start gap-8px'>
          <span
            className='mt-3px shrink-0 size-10px rd-full'
            style={{ backgroundColor: LAYER_COLORS[node.layer] }}
            aria-hidden
          />
          <span className='text-15px font-700 text-t-primary break-words leading-tight'>{node.label}</span>
        </div>
        <div className='flex items-center gap-6px flex-wrap'>
          <Tag
            size='small'
            className='!text-10px !leading-none !px-6px !py-3px'
            style={{ color: LAYER_COLORS[node.layer], borderColor: LAYER_COLORS[node.layer] }}
            bordered
          >
            {t(`ide.understand.layer.${node.layer}`)}
          </Tag>
          {node.language ? (
            <Tag size='small' className='!text-10px !leading-none !px-6px !py-3px'>
              {node.language}
            </Tag>
          ) : null}
          {node.importedBy > 0 ? (
            <span className='text-10px text-t-tertiary'>
              {t('ide.understand.detail.importedBy', { count: node.importedBy })}
            </span>
          ) : null}
        </div>
        <span className='flex items-center gap-5px text-11px text-t-tertiary' title={node.id}>
          <Code theme='outline' size={12} className='shrink-0' />
          <span className='truncate'>{node.id}</span>
        </span>
      </div>

      {node.summary ? (
        <Section
          icon={<Search theme='outline' size={13} />}
          title={t('ide.understand.detail.summary')}
          badge={<SummaryBadge source={node.summarySource} />}
        >
          <p className='m-0 text-13px text-t-secondary leading-relaxed'>{node.summary}</p>
        </Section>
      ) : null}

      {node.tags.length > 0 ? (
        <Section icon={<Label theme='outline' size={13} />} title={t('ide.understand.detail.tags')}>
          <div className='flex items-center gap-6px flex-wrap'>
            {node.tags.map((tag) => (
              <Tag key={tag} size='small' className='!text-10px !leading-none !px-6px !py-3px bg-fill-2'>
                {tag}
              </Tag>
            ))}
          </div>
        </Section>
      ) : null}

      <Section
        icon={<Code theme='outline' size={13} />}
        title={t('ide.understand.detail.symbols', { count: node.symbols.length })}
      >
        {node.symbols.length === 0 ? (
          <p className='m-0 text-12px text-t-tertiary'>{t('ide.understand.detail.noSymbols')}</p>
        ) : (
          <SymbolList symbols={node.symbols} />
        )}
      </Section>
    </div>
  );
};

/** Badge marking a deterministic (non-LLM) fallback summary. LLM summaries need no badge. */
const SummaryBadge: React.FC<{ source?: 'llm' | 'fallback' }> = ({ source }) => {
  const { t } = useTranslation();
  if (source !== 'fallback') {
    return null;
  }
  return (
    <Tooltip content={t('ide.understand.detail.fallbackHint')}>
      <span className='flex items-center gap-3px text-9px font-600 px-5px py-2px rd-full bg-fill-2 text-t-tertiary'>
        <Lightning theme='outline' size={10} />
        {t('ide.understand.detail.fallbackBadge')}
      </span>
    </Tooltip>
  );
};

/** A titled section block within the detail card (with an optional trailing badge). */
const Section: React.FC<{
  icon: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, title, badge, children }) => (
  <div className='flex flex-col gap-8px'>
    <span className='flex items-center gap-6px text-11px font-600 uppercase tracking-wide text-t-tertiary'>
      {icon}
      {title}
      {badge ? <span className='ml-auto'>{badge}</span> : null}
    </span>
    {children}
  </div>
);

/** Symbols grouped by kind, each with its 1-based line number. */
const SymbolList: React.FC<{ symbols: CodeSymbol[] }> = ({ symbols }) => {
  const { t } = useTranslation();
  const groups = useMemo(() => {
    const map = new Map<CodeSymbol['kind'], CodeSymbol[]>();
    for (const symbol of symbols) {
      const list = map.get(symbol.kind) ?? [];
      list.push(symbol);
      map.set(symbol.kind, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.line - b.line);
    return Array.from(map.entries());
  }, [symbols]);

  return (
    <div className='flex flex-col gap-10px'>
      {groups.map(([kind, list]) => (
        <div key={kind} className='flex flex-col gap-3px'>
          <span className='text-10px font-600 uppercase tracking-wide text-t-tertiary'>
            {t(`ide.understand.symbolKind.${kind}`)}
          </span>
          {list.map((symbol) => (
            <span
              key={`${symbol.name}-${symbol.line}`}
              className='flex items-center gap-6px px-8px py-4px rd-6px bg-fill-1 hover:bg-fill-2 transition-colors'
            >
              <span className='flex-1 truncate font-mono text-12px text-t-primary' title={symbol.name}>
                {symbol.name}
              </span>
              <span className='shrink-0 font-mono text-10px text-t-tertiary'>
                {t('ide.understand.detail.line', { line: symbol.line })}
              </span>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
};

export default NodeDetailRail;
