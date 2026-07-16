/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import { useSettingsViewMode } from '@/renderer/components/settings/SettingsModal/settingsViewContext';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { BuildingTwo, Play, Robot } from '@icon-park/react';
import { Button, Message } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import CompanyPicker from './components/CompanyPicker';
import DescribeCompany from './components/DescribeCompany';
import RulesEditor from './components/RulesEditor';
import StructurePanel from './components/StructurePanel';
import ManagerPopup from './manager/ManagerPopup';
import { openRoleChat } from './companySession';
import { useCompanyState } from './useCompanyState';

/**
 * Agent Company content (Requirement 3 — multi-tier agent company).
 *
 * Composes the company roster, the create-from-description form (criterion
 * 3.11), the generated role structure view (criterion 3.2), and the company
 * rules editor (criterion 3.10) into a single scrollable surface. All
 * company-service access flows through {@link useCompanyState}, which degrades
 * gracefully to friendly empty/error states when the Main-process bridge is not
 * wired yet (Task 15.1).
 *
 * The page depends on the native IPC company bridge, so it is gated to the
 * desktop app — in WebUI mode it shows a short notice instead (mirrors how the
 * Resource Dashboard is desktop-only).
 */
const CompanyPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';
  const isDesktop = isElectronDesktop();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);

  const {
    knownIds,
    activeId,
    selectCompany,
    addCompany,
    forgetCompany,
    structure,
    structureStatus,
    refreshStructure,
    rules,
    rulesStatus,
    saveRules,
    createFromDescription,
    strengthsGuidance,
    saveStrengthsGuidance,
    agents,
    setAssignment,
    acceptDrafts,
    draftCount,
    updateStructure,
    generationRunning,
    generationStartedAt,
  } = useCompanyState();

  const canStart = isDesktop && structureStatus === 'ready' && !!structure && !!activeId;

  const handleStart = async () => {
    if (!structure || !activeId) return;
    setStarting(true);
    const closeLoading = Message.loading({ content: t('company.sider.chatOpening'), duration: 0 });
    try {
      const convId = await openRoleChat({
        companyId: activeId,
        companyName: activeId,
        role: structure.root,
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
    } catch (error) {
      closeLoading();
      console.error('Failed to start company chat:', error);
      Message.error(t('company.sider.chatOpenError'));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className='flex flex-col h-full w-full'>
      <header className='mb-16px flex items-start justify-between gap-16px'>
        <div className='min-w-0'>
          <h2 className='m-0 text-20px font-700 text-t-primary'>{t('company.title')}</h2>
          <p className='m-0 mt-4px text-13px text-t-secondary'>{t('company.subtitle')}</p>
        </div>
        {canStart && (
          <div className='flex shrink-0 items-center gap-8px'>
            <Button icon={<Robot theme='outline' size='16' />} onClick={() => setManagerOpen(true)}>
              {t('company.conversation.openManager')}
            </Button>
            <Button
              type='primary'
              icon={<Play theme='outline' size='16' />}
              loading={starting}
              onClick={() => void handleStart()}
            >
              {t('company.sider.start')}
            </Button>
          </div>
        )}
      </header>

      <AionScrollArea className='flex-1 min-h-0 pb-16px' disableOverflow={isPageMode}>
        {!isDesktop ? (
          <div className='flex flex-col items-center gap-12px py-56px text-center'>
            <span className='size-48px flex-center rd-full bg-fill-2 text-t-tertiary'>
              <BuildingTwo theme='outline' size='24' />
            </span>
            <p className='m-0 max-w-420px text-13px text-t-secondary'>{t('company.desktopOnly')}</p>
          </div>
        ) : (
          <div className='flex flex-col gap-16px'>
            <div className='grid grid-cols-1 lg:grid-cols-2 gap-16px'>
              <CompanyPicker
                knownIds={knownIds}
                activeId={activeId}
                onSelect={selectCompany}
                onAdd={addCompany}
                onForget={forgetCompany}
              />
              <DescribeCompany
                onCreate={createFromDescription}
                strengthsGuidance={strengthsGuidance}
                onChangeStrengthsGuidance={saveStrengthsGuidance}
                generationRunning={generationRunning}
                generationStartedAt={generationStartedAt}
              />
            </div>
            <StructurePanel
              structure={structure}
              status={structureStatus}
              onRefresh={refreshStructure}
              agents={agents}
              draftCount={draftCount}
              onSetAssignment={setAssignment}
              onAcceptDrafts={acceptDrafts}
              onUpdateStructure={updateStructure}
            />
            <RulesEditor rules={rules} status={rulesStatus} onSave={saveRules} />
          </div>
        )}
      </AionScrollArea>

      <ManagerPopup
        visible={managerOpen}
        onClose={() => setManagerOpen(false)}
        companyId={activeId}
        companyName={activeId ?? undefined}
        rules={rules}
        structure={structure}
        language={i18n.language}
      />
    </div>
  );
};

export default CompanyPage;
