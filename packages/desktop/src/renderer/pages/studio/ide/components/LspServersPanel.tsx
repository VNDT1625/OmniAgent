/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `LspServersPanel` — the opt-in surface for real language-server intelligence.
 *
 * Nothing is bundled or auto-downloaded. This panel runs `mtui analyze type` for
 * the open folder, shows which languages would benefit from a language server
 * (and which the user already installed), and lets the user EXPLICITLY install
 * one. npm-distributed servers (typescript-language-server, pyright) are fetched
 * into the app's data dir on click; binary-release servers (rust-analyzer,
 * gopls, clangd) are adopted from PATH or, if absent, the panel shows how to
 * install them manually (never a silent system-wide download).
 *
 * Once installed, the editor's {@link TextCodeAdapter} attaches the server for
 * that language automatically (completion / hover / definition / rename /
 * format / diagnostics) — so the IDE is useful for coding WITHOUT any agent.
 *
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all strings via i18n.
 */

import { Button, Empty, Message, Spin, Tag, Tooltip } from '@arco-design/web-react';
import { CheckOne, Download, Info, Lightning, Refresh } from '@icon-park/react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ideClient } from '../ideClient';
import { lspClient, type LspServerStatus } from '../lspClient';

type LspServersPanelProps = {
  /** Absolute path of the open folder. */
  rootPath: string;
};

/** A language the analysis recommends a server for, joined with install state. */
type Recommendation = {
  status: LspServerStatus;
  /** Languages in the repo this server would cover. */
  languages: string[];
  /** Total files across those languages (relevance hint). */
  fileCount: number;
};

/** Cost → Arco tag color. */
const COST_COLOR: Record<string, string> = {
  light: 'green',
  medium: 'orange',
  heavy: 'red',
};

const LspServersPanel: React.FC<LspServersPanelProps> = ({ rootPath }) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [installingId, setInstallingId] = useState<string | null>(null);

  /** Run analysis + cross-reference install state into the recommendation list. */
  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [analysis, list] = await Promise.all([
        ideClient.analyzeLanguages(rootPath).catch((): null => null),
        lspClient.list().catch((): null => null),
      ]);
      if (!list || !list.ok) {
        setRecommendations([]);
        return;
      }
      // Group recommended `lsp` languages by their catalog server.
      const byServer = new Map<string, Recommendation>();
      const langs = analysis && analysis.ok ? analysis.data.languages : [];
      for (const entry of langs) {
        if (entry.engine.kind !== 'lsp') continue;
        const status = list.data.find((s: LspServerStatus) => s.server.languages.includes(entry.language));
        if (!status) continue;
        const existing = byServer.get(status.server.id);
        if (existing) {
          existing.languages.push(entry.language);
          existing.fileCount += entry.fileCount;
        } else {
          byServer.set(status.server.id, { status, languages: [entry.language], fileCount: entry.fileCount });
        }
      }
      // Also surface already-installed servers even if not in this repo's analysis.
      for (const status of list.data) {
        if (status.installed && !byServer.has(status.server.id)) {
          byServer.set(status.server.id, { status, languages: status.server.languages, fileCount: 0 });
        }
      }
      setRecommendations([...byServer.values()].toSorted((a, b) => b.fileCount - a.fileCount));
    } finally {
      setLoading(false);
    }
  }, [rootPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Install (or adopt) a server on explicit user click. */
  const handleInstall = useCallback(
    async (serverId: string): Promise<void> => {
      setInstallingId(serverId);
      try {
        const res = await lspClient.install(serverId).catch((): null => null);
        if (!res || !res.ok) {
          Message.error(t('ide.lsp.installError'));
          return;
        }
        const outcome = res.data;
        if (outcome.status === 'installed' || outcome.status === 'already-installed') {
          Message.success(t('ide.lsp.installed'));
          await refresh();
        } else if (outcome.status === 'needs-manual') {
          Message.info(outcome.instructions);
        } else {
          Message.error(t('ide.lsp.installError'));
        }
      } finally {
        setInstallingId(null);
      }
    },
    [refresh, t]
  );

  if (loading) {
    return (
      <div className='size-full flex-center'>
        <Spin tip={t('ide.lsp.analyzing')} />
      </div>
    );
  }

  return (
    <div className='size-full flex flex-col min-h-0 bg-1'>
      <header className='shrink-0 flex items-center gap-8px px-16px h-48px border-b border-b-1'>
        <Lightning theme='outline' size={16} className='text-primary' />
        <span className='text-14px font-[500] text-t-primary'>{t('ide.lsp.title')}</span>
        <div className='flex-1' />
        <Button type='text' size='small' icon={<Refresh theme='outline' size={14} />} onClick={() => void refresh()}>
          {t('ide.lsp.rescan')}
        </Button>
      </header>

      <div className='flex-1 min-h-0 overflow-auto p-16px flex flex-col gap-12px'>
        <p className='m-0 text-12px text-t-secondary leading-relaxed flex items-start gap-6px'>
          <Info theme='outline' size={14} className='mt-2px shrink-0' />
          {t('ide.lsp.hint')}
        </p>

        {recommendations.length === 0 ? (
          <Empty description={t('ide.lsp.none')} />
        ) : (
          recommendations.map(({ status, languages, fileCount }) => (
            <div key={status.server.id} className='flex items-center gap-12px p-12px rd-10px border border-b-1 bg-2'>
              <span className='size-36px shrink-0 flex-center rd-8px bg-primary-light-1 text-primary'>
                <Lightning theme='outline' size={18} />
              </span>
              <div className='flex-1 min-w-0'>
                <div className='flex items-center gap-8px'>
                  <span className='text-13px font-[500] text-t-primary truncate'>{status.server.displayName}</span>
                  <Tag size='small' color={COST_COLOR[status.server.cost] ?? 'gray'}>
                    {t(`ide.lsp.cost.${status.server.cost}`)}
                  </Tag>
                  <span className='text-11px text-t-tertiary'>~{status.server.approxSizeMb}MB</span>
                </div>
                <div className='text-11px text-t-tertiary truncate'>
                  {languages.join(', ')}
                  {fileCount > 0 ? ` · ${t('ide.lsp.fileCount', { count: fileCount })}` : ''}
                </div>
              </div>
              {status.installed ? (
                <Tag color='green' icon={<CheckOne theme='outline' size={12} />}>
                  {t('ide.lsp.installedTag')}
                </Tag>
              ) : (
                <Tooltip content={t('ide.lsp.installHint')}>
                  <Button
                    type='primary'
                    size='small'
                    icon={<Download theme='outline' size={14} />}
                    loading={installingId === status.server.id}
                    onClick={() => void handleInstall(status.server.id)}
                  >
                    {t('ide.lsp.install')}
                  </Button>
                </Tooltip>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default LspServersPanel;
