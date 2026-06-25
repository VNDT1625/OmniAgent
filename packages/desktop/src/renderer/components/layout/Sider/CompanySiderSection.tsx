/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Company tree for the left sidebar (Part 2b — Company chat).
 *
 * Lists every known company as a collapsible folder; expanding one reveals its
 * role tree (President → divisions → division head + workers). Clicking any role
 * opens (or reuses) a 1-1 chat with that role's assigned executor via
 * {@link openRoleChat} and navigates to it.
 *
 * Mirrors {@link TeamSiderSection} in shape (collapsed vs expanded modes,
 * `localStorage`-backed expand state, navigate-on-click) and reuses the
 * company bridge client + the company role-chat session helper. Per-company
 * structure/rules are loaded lazily (only when a company is expanded) and cached
 * with SWR keyed by company id.
 *
 * Process boundary: Renderer component. No Node.js APIs.
 */

import type { CompanyStructure, RoleNode } from '@process/company/companyOrchestrator';
import { BuildingTwo, People, Peoples, Right, Robot } from '@icon-park/react';
import { Message, Tooltip } from '@arco-design/web-react';
import classNames from 'classnames';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import { cleanupSiderTooltips } from '@renderer/utils/ui/siderTooltip';
import { blurActiveElement } from '@renderer/utils/ui/focus';
import { companyClient } from '@renderer/pages/company/companyBridgeClient';
import { loadKnownCompanies } from '@renderer/pages/company/constants';
import { openRoleChat } from '@renderer/pages/company/companySession';

type SiderTooltipProps = React.ComponentProps<typeof Tooltip>;

interface CompanySiderSectionProps {
  collapsed: boolean;
  pathname: string;
  siderTooltipProps: Partial<SiderTooltipProps>;
  onSessionClick?: () => void;
}

const SECTION_EXPANDED_KEY = 'company-section-expanded';
const COMPANY_EXPANDED_KEY = 'company-expanded-ids';
const DIVISION_EXPANDED_KEY = 'company-division-expanded';

/** Safe JSON-array read from localStorage (mirrors the company constants style). */
const readIdList = (storageKey: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
};

/** Loaded company data the tree needs to render rows and open role chats. */
type CompanyData = { structure: CompanyStructure | null; rules: string[] };

/** Lazy loader for one company's structure + rules via the company bridge. */
const loadCompanyData = async (companyId: string): Promise<CompanyData> => {
  const [structureRes, rulesRes] = await Promise.all([
    companyClient.getStructure.invoke({ companyId }).catch((): undefined => undefined),
    companyClient.getRules.invoke({ companyId }).catch((): undefined => undefined),
  ]);
  const structure =
    structureRes && (structureRes as { ok?: boolean }).ok
      ? ((structureRes as { data?: CompanyStructure }).data ?? null)
      : null;
  const rules =
    rulesRes && (rulesRes as { ok?: boolean }).ok && Array.isArray((rulesRes as { data?: string[] }).data)
      ? ((rulesRes as { data?: string[] }).data as string[])
      : [];
  return { structure, rules };
};

/** A single clickable/role row, indented and styled like the team sider items. */
const TreeRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  depth: number;
  chevron?: 'none' | 'collapsed' | 'expanded';
  guide?: boolean;
  onClick: () => void;
}> = ({ icon, label, depth, chevron = 'none', guide = false, onClick }) => (
  <div className='relative' style={{ paddingLeft: depth * 14 }}>
    {guide && (
      <span aria-hidden className='absolute top-0 bottom-0 w-1px bg-border-2' style={{ left: depth * 14 - 7 }} />
    )}
    <div
      className='h-32px rd-8px flex items-center gap-8px pl-10px pr-8px cursor-pointer relative overflow-hidden shrink-0 group min-w-0 transition-colors hover:bg-fill-3'
      onClick={onClick}
    >
      {chevron !== 'none' && (
        <Right
          theme='outline'
          size={12}
          className={classNames('shrink-0 text-t-tertiary transition-transform duration-150', {
            'rotate-90': chevron === 'expanded',
          })}
        />
      )}
      <span className='size-18px flex items-center justify-center shrink-0 line-height-0 text-t-secondary'>{icon}</span>
      <span className='flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-13px font-[500] text-t-primary'>
        {label}
      </span>
    </div>
  </div>
);

/** One company folder + its lazily-loaded role tree. */
const CompanyBranch: React.FC<{
  companyId: string;
  language: string;
  onOpenRole: (companyId: string, structure: CompanyStructure, rules: string[], role: RoleNode) => void;
}> = ({ companyId, language, onOpenRole }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<boolean>(() => readIdList(COMPANY_EXPANDED_KEY).includes(companyId));
  const [openDivisions, setOpenDivisions] = useState<string[]>(() => readIdList(DIVISION_EXPANDED_KEY));

  const { data } = useSWR(expanded ? ['company-tree', companyId] : null, () => loadCompanyData(companyId));
  const structure = data?.structure ?? null;
  const rules = data?.rules ?? [];

  const toggleCompany = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      const ids = readIdList(COMPANY_EXPANDED_KEY).filter((id) => id !== companyId);
      if (next) ids.push(companyId);
      localStorage.setItem(COMPANY_EXPANDED_KEY, JSON.stringify(ids));
      return next;
    });
  }, [companyId]);

  const toggleDivision = useCallback((divisionKey: string) => {
    setOpenDivisions((prev) => {
      const next = prev.includes(divisionKey) ? prev.filter((k) => k !== divisionKey) : [...prev, divisionKey];
      localStorage.setItem(DIVISION_EXPANDED_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const handleRole = useCallback(
    (role: RoleNode) => {
      if (!structure) return;
      onOpenRole(companyId, structure, rules, role);
    },
    [companyId, onOpenRole, rules, structure]
  );

  const divisionHeads = useMemo(
    () => (structure ? structure.root.children.filter((c) => c.role === 'division-head') : []),
    [structure]
  );
  const directWorkers = useMemo(
    () => (structure ? structure.root.children.filter((c) => c.role === 'worker') : []),
    [structure]
  );

  return (
    <div className='flex flex-col gap-1px'>
      <TreeRow
        icon={<BuildingTwo theme='outline' size='16' fill='currentColor' />}
        label={companyId}
        depth={0}
        chevron={expanded ? 'expanded' : 'collapsed'}
        onClick={toggleCompany}
      />
      {expanded && structure && (
        <>
          {/* President */}
          <TreeRow
            icon={<People theme='outline' size='15' fill='currentColor' />}
            label={structure.root.name}
            depth={1}
            guide
            onClick={() => handleRole(structure.root)}
          />

          {/* Divisions → head + workers */}
          {divisionHeads.map((head) => {
            const divisionKey = `${companyId}::${head.divisionId ?? head.id}`;
            const open = openDivisions.includes(divisionKey);
            const workers = head.children.filter((c) => c.role === 'worker');
            return (
              <React.Fragment key={head.id}>
                <TreeRow
                  icon={<Peoples theme='outline' size='15' fill='currentColor' />}
                  label={head.name}
                  depth={1}
                  chevron={open ? 'expanded' : 'collapsed'}
                  guide
                  onClick={() => toggleDivision(divisionKey)}
                />
                {open && (
                  <>
                    <TreeRow
                      icon={<People theme='outline' size='14' fill='currentColor' />}
                      label={`${head.name} · ${t('company.role.divisionHead')}`}
                      depth={2}
                      guide
                      onClick={() => handleRole(head)}
                    />
                    {workers.map((worker) => (
                      <TreeRow
                        key={worker.id}
                        icon={<Robot theme='outline' size='14' fill='currentColor' />}
                        label={worker.assignment?.label ?? worker.name}
                        depth={2}
                        guide
                        onClick={() => handleRole(worker)}
                      />
                    ))}
                  </>
                )}
              </React.Fragment>
            );
          })}

          {/* Small-company case: workers reporting straight to the President */}
          {directWorkers.map((worker) => (
            <TreeRow
              key={worker.id}
              icon={<Robot theme='outline' size='14' fill='currentColor' />}
              label={worker.assignment?.label ?? worker.name}
              depth={1}
              guide
              onClick={() => handleRole(worker)}
            />
          ))}
        </>
      )}
    </div>
  );
};

const CompanySiderSection: React.FC<CompanySiderSectionProps> = ({ collapsed, siderTooltipProps, onSessionClick }) => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [companyIds, setCompanyIds] = useState<string[]>(() => loadKnownCompanies());
  const [sectionExpanded, setSectionExpanded] = useState<boolean>(
    () => localStorage.getItem(SECTION_EXPANDED_KEY) === 'true'
  );

  useEffect(() => {
    localStorage.setItem(SECTION_EXPANDED_KEY, String(sectionExpanded));
  }, [sectionExpanded]);

  // Keep the roster fresh: re-read the known-companies list on window focus and
  // on the storage event (e.g. after creating a company on the Company page).
  useEffect(() => {
    const refresh = () => setCompanyIds(loadKnownCompanies());
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const handleOpenRole = useCallback(
    async (companyId: string, structure: CompanyStructure, rules: string[], role: RoleNode) => {
      cleanupSiderTooltips();
      blurActiveElement();
      const closeLoading = Message.loading({ content: t('company.sider.chatOpening'), duration: 0 });
      try {
        const convId = await openRoleChat({
          companyId,
          companyName: companyId,
          role,
          structure,
          rules,
          language: i18n.language,
        });
        closeLoading();
        if (!convId) {
          Message.error(t('company.sider.chatOpenError'));
          return;
        }
        await Promise.resolve(navigate(`/conversation/${convId}`)).catch(console.error);
        if (onSessionClick) onSessionClick();
      } catch (error) {
        closeLoading();
        console.error('Failed to open company role chat:', error);
        Message.error(t('company.sider.chatOpenError'));
      }
    },
    [i18n.language, navigate, onSessionClick, t]
  );

  const goToCompanySettings = useCallback(() => {
    cleanupSiderTooltips();
    blurActiveElement();
    Promise.resolve(navigate('/settings/company')).catch(console.error);
    if (onSessionClick) onSessionClick();
  }, [navigate, onSessionClick]);

  if (companyIds.length === 0) return null;

  if (collapsed) {
    return (
      <div className='shrink-0 flex flex-col gap-2px'>
        {companyIds.map((companyId) => (
          <Tooltip key={companyId} {...siderTooltipProps} content={companyId} position='right'>
            <div
              className='relative w-full h-40px flex items-center justify-center cursor-pointer transition-colors rd-8px hover:bg-fill-3 active:bg-fill-4'
              onClick={goToCompanySettings}
            >
              <BuildingTwo
                theme='outline'
                size='16'
                fill='currentColor'
                className='text-t-secondary'
                style={{ lineHeight: 0 }}
              />
            </div>
          </Tooltip>
        ))}
      </div>
    );
  }

  return (
    <div className='shrink-0 flex flex-col gap-2px'>
      <div
        className='group/label sider-section-label flex items-center px-12px h-28px select-none sticky top-0 z-10 mt-8px cursor-pointer'
        onClick={() => setSectionExpanded((v) => !v)}
      >
        <span className='text-14px text-t-tertiary sider-section-title group-hover/label:text-t-primary transition-colors font-[500] leading-none'>
          {t('company.sider.title')}
        </span>
        <span className='ml-2px flex items-center justify-center opacity-0 group-hover/label:opacity-100 transition-opacity text-t-tertiary shrink-0'>
          <Right
            theme='outline'
            size={12}
            className={classNames('transition-transform duration-150', { 'rotate-90': sectionExpanded })}
          />
        </span>
      </div>
      {sectionExpanded &&
        companyIds.map((companyId) => (
          <CompanyBranch
            key={companyId}
            companyId={companyId}
            language={i18n.language}
            onOpenRole={(cid, structure, rules, role) => void handleOpenRole(cid, structure, rules, role)}
          />
        ))}
    </div>
  );
};

export default CompanySiderSection;
