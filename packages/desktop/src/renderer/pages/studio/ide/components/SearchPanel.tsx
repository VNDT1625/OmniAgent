/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `SearchPanel` — global project-wide text search for the IDE.
 *
 * Uses the `ide.grep` IPC channel (Main-process ripgrep/Node walk) to search
 * all files in the open folder. Results are grouped by file and show the
 * matching line with context. Clicking a result opens the file in the editor.
 *
 * Degrades gracefully: if the `ide.grep` channel is not registered yet, shows a
 * friendly "not available" notice instead of hanging.
 *
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { Button, Input, Message, Spin, Tag, Tooltip } from '@arco-design/web-react';
import { Close, FileText, Refresh, Search, Transform } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ideClient } from '../ideClient';

type SearchPanelProps = {
  rootPath: string;
  onOpenFile: (path: string) => void;
};

export type GrepMatch = {
  /** Absolute file path. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** The matching line text (trimmed). */
  text: string;
};

export type GrepResult = {
  /** Relative path from rootPath. */
  relPath: string;
  /** Absolute path. */
  absPath: string;
  matches: GrepMatch[];
};

/** Group flat GrepMatch[] by file path into GrepResult[]. */
const groupByFile = (matches: GrepMatch[], rootPath: string): GrepResult[] => {
  const map = new Map<string, GrepResult>();
  const sep = rootPath.includes('\\') && !rootPath.includes('/') ? '\\' : '/';
  for (const m of matches) {
    if (!map.has(m.path)) {
      const rel = m.path.startsWith(rootPath) ? m.path.slice(rootPath.length).replace(/^[/\\]/, '') : m.path;
      map.set(m.path, { relPath: rel.replace(/\\/g, '/'), absPath: m.path, matches: [] });
    }
    map.get(m.path)!.matches.push(m);
  }
  void sep; // used above
  return Array.from(map.values());
};

const baseOf = (p: string): string => p.split('/').pop() ?? p;

const SearchPanel: React.FC<SearchPanelProps> = ({ rootPath, onOpenFile }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [results, setResults] = useState<GrepResult[]>([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const doSearch = useCallback(async (): Promise<void> => {
    if (!query.trim()) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    setSearched(false);
    try {
      const res = await ideClient.grep(rootPath, query.trim(), { caseSensitive, regex: useRegex });
      if (ctrl.signal.aborted) return;
      if (res.ok) {
        const grouped = groupByFile(res.data, rootPath);
        setResults(grouped);
        setTotalMatches(res.data.length);
        setExpandedFiles(new Set(grouped.map((g) => g.absPath)));
      } else {
        setError((res as { error?: string }).error ?? t('ide.search.error'));
        setResults([]);
        setTotalMatches(0);
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError(err instanceof Error ? err.message : t('ide.search.error'));
      setResults([]);
      setTotalMatches(0);
    } finally {
      if (!ctrl.signal.aborted) {
        setLoading(false);
        setSearched(true);
      }
    }
  }, [query, rootPath, caseSensitive, useRegex, t]);

  const toggleFile = (absPath: string): void => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(absPath)) next.delete(absPath);
      else next.add(absPath);
      return next;
    });
  };

  // Replace every match across all result files via the per-file MTUI gateway,
  // then re-run the search so the results reflect the new file contents.
  const doReplaceAll = useCallback(async (): Promise<void> => {
    if (!query.trim() || results.length === 0 || replacing) return;
    setReplacing(true);
    try {
      const counts = await Promise.all(
        results.map(async (group): Promise<number> => {
          const res = await ideClient
            .replaceFile({
              path: group.absPath,
              query: query.trim(),
              replacement,
              caseSensitive,
              regex: useRegex,
            })
            .catch((): null => null);
          return res && res.ok ? res.data : 0;
        })
      );
      const total = counts.reduce((sum, count) => sum + count, 0);
      Message.success(t('ide.search.replacedAll', { count: total }));
      await doSearch();
    } finally {
      setReplacing(false);
    }
  }, [query, replacement, results, replacing, caseSensitive, useRegex, doSearch, t]);

  return (
    <div className='flex flex-col h-full min-h-0'>
      {/* Search input */}
      <div className='shrink-0 px-12px pt-12px pb-8px flex flex-col gap-6px'>
        <div className='flex items-center gap-6px'>
          <Tooltip content={t('ide.search.toggleReplace')} mini>
            <Button
              type={showReplace ? 'primary' : 'secondary'}
              size='small'
              icon={<Transform theme='outline' size={14} />}
              onClick={() => setShowReplace((v) => !v)}
            />
          </Tooltip>
          <div className='flex-1 relative'>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doSearch();
              }}
              placeholder={t('ide.search.placeholder')}
              className='w-full h-30px px-10px pr-32px rd-8px bg-fill-2 border border-arco-2 text-12px text-t-primary placeholder:text-t-tertiary outline-none focus:border-primary transition-colors font-mono'
              aria-label={t('ide.search.placeholder')}
            />
            {query ? (
              <button
                type='button'
                onClick={() => {
                  setQuery('');
                  setResults([]);
                  setSearched(false);
                }}
                className='absolute right-6px top-1/2 -translate-y-1/2 size-16px flex-center rd-4px text-t-tertiary hover:text-t-primary border-none bg-transparent cursor-pointer'
              >
                <Close theme='outline' size={11} />
              </button>
            ) : null}
          </div>
          <Tooltip content={t('ide.search.search')} mini>
            <Button
              type='primary'
              size='small'
              icon={<Search theme='outline' size={14} />}
              loading={loading}
              onClick={() => void doSearch()}
            />
          </Tooltip>
        </div>
        {showReplace ? (
          <div className='flex items-center gap-6px'>
            <span className='size-28px shrink-0' />
            <Input
              size='small'
              className='flex-1 font-mono'
              value={replacement}
              onChange={setReplacement}
              placeholder={t('ide.search.replacePlaceholder')}
              onPressEnter={() => void doReplaceAll()}
            />
            <Tooltip content={t('ide.search.replaceAll')} mini>
              <Button
                size='small'
                status='warning'
                loading={replacing}
                disabled={results.length === 0}
                onClick={() => void doReplaceAll()}
              >
                {t('ide.search.replaceAllShort')}
              </Button>
            </Tooltip>
          </div>
        ) : null}
        {/* Options */}
        <div className='flex items-center gap-8px'>
          <button
            type='button'
            onClick={() => setCaseSensitive((v) => !v)}
            title={t('ide.search.caseSensitive')}
            className={`h-20px px-6px rd-4px text-11px font-600 border border-arco-2 cursor-pointer transition-colors ${caseSensitive ? 'bg-primary text-white border-primary' : 'bg-transparent text-t-secondary hover:bg-fill-2'}`}
          >
            Aa
          </button>
          <button
            type='button'
            onClick={() => setUseRegex((v) => !v)}
            title={t('ide.search.useRegex')}
            className={`h-20px px-6px rd-4px text-11px font-mono border border-arco-2 cursor-pointer transition-colors ${useRegex ? 'bg-primary text-white border-primary' : 'bg-transparent text-t-secondary hover:bg-fill-2'}`}
          >
            .*
          </button>
          {searched && !loading ? (
            <span className='text-11px text-t-tertiary ml-auto'>
              {results.length === 0
                ? t('ide.search.noResults')
                : t('ide.search.results', { files: results.length, matches: totalMatches })}
            </span>
          ) : null}
        </div>
      </div>

      {/* Results */}
      <div className='flex-1 min-h-0 overflow-y-auto px-8px pb-8px'>
        {loading ? (
          <div className='flex-center h-full'>
            <Spin />
          </div>
        ) : error ? (
          <div className='flex flex-col items-center gap-10px pt-24px text-center px-12px'>
            <p className='m-0 text-12px text-t-secondary'>{error}</p>
            <Button size='small' icon={<Refresh theme='outline' size={13} />} onClick={() => void doSearch()}>
              {t('ide.search.retry')}
            </Button>
          </div>
        ) : !searched ? (
          <div className='flex-center h-full text-center px-12px'>
            <p className='m-0 text-12px text-t-tertiary'>{t('ide.search.hint')}</p>
          </div>
        ) : results.length === 0 ? (
          <div className='flex-center h-full text-center px-12px'>
            <p className='m-0 text-12px text-t-secondary'>{t('ide.search.noResults')}</p>
          </div>
        ) : (
          results.map((group) => {
            const expanded = expandedFiles.has(group.absPath);
            return (
              <div key={group.absPath} className='mb-4px'>
                {/* File header */}
                <button
                  type='button'
                  onClick={() => toggleFile(group.absPath)}
                  className='w-full flex items-center gap-6px px-8px py-5px rd-6px hover:bg-fill-2 cursor-pointer border-none bg-transparent text-left transition-colors'
                >
                  <FileText theme='outline' size={13} className='text-t-secondary shrink-0' />
                  <span className='text-12px font-600 text-t-primary truncate flex-1' title={group.relPath}>
                    {baseOf(group.relPath)}
                  </span>
                  <span className='text-10px text-t-tertiary truncate max-w-120px'>{group.relPath}</span>
                  <Tag size='small' className='!text-10px shrink-0'>
                    {group.matches.length}
                  </Tag>
                </button>
                {/* Match lines */}
                {expanded
                  ? group.matches.map((match, i) => (
                      <button
                        key={i}
                        type='button'
                        onClick={() => onOpenFile(match.path)}
                        className='w-full flex items-start gap-8px px-16px py-4px rd-6px hover:bg-primary-light-1 cursor-pointer border-none bg-transparent text-left transition-colors group'
                      >
                        <span className='text-10px text-t-tertiary shrink-0 pt-1px w-32px text-right font-mono'>
                          {match.line}
                        </span>
                        <span className='text-11px text-t-secondary font-mono truncate group-hover:text-t-primary'>
                          {match.text}
                        </span>
                      </button>
                    ))
                  : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default SearchPanel;
