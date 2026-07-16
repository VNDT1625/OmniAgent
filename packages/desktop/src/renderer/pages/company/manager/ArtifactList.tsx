/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Artifact list for the real-work pipeline (spec agent-company-pipeline,
 * Requirement 7.3). Lists what the company produced — design docs, reports,
 * test reports, code changes — with a badge for model-only (simulated) output
 * and an "open" affordance for artifacts backed by a real file path.
 *
 * Renderer-only. Arco + UnoCSS semantic tokens; all copy via i18n.
 */

import type { Artifact, ArtifactKind } from '../pipeline/pipelineTypes';
import { Code, DocDetail, ExperimentOne, FileText, Notes } from '@icon-park/react';
import { Tag } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

/** Icon per artifact kind. */
const KindIcon: React.FC<{ kind: ArtifactKind }> = ({ kind }) => {
  switch (kind) {
    case 'doc':
      return <DocDetail theme='outline' size='15' />;
    case 'report':
      return <FileText theme='outline' size='15' />;
    case 'test-report':
      return <ExperimentOne theme='outline' size='15' />;
    case 'code-change':
      return <Code theme='outline' size='15' />;
    default:
      return <Notes theme='outline' size='15' />;
  }
};

/** The artifact list. */
const ArtifactList: React.FC<{ artifacts: Artifact[] }> = ({ artifacts }) => {
  const { t } = useTranslation();

  if (artifacts.length === 0) {
    return <p className='m-0 py-20px text-center text-12px text-t-tertiary'>{t('company.pipeline.artifactsEmpty')}</p>;
  }

  return (
    <div className='flex flex-col gap-8px'>
      {artifacts.map((a) => (
        <div key={a.id} className='flex items-start gap-8px rd-10px border border-solid border-b-1 bg-1 px-10px py-8px'>
          <span className='mt-2px size-24px flex-center rd-6px bg-fill-2 text-t-secondary'>
            <KindIcon kind={a.kind} />
          </span>
          <div className='min-w-0 flex-1'>
            <div className='flex items-center gap-6px'>
              <span className='truncate text-13px font-600 text-t-primary'>{a.title}</span>
              <Tag size='small' bordered>
                {t(`company.pipeline.artifactKind.${a.kind}`)}
              </Tag>
              {a.simulated && (
                <Tag color='orange' size='small' bordered>
                  {t('company.pipeline.simulated')}
                </Tag>
              )}
            </div>
            {a.preview && <p className='m-0 mt-2px line-clamp-2 text-11px text-t-tertiary'>{a.preview}</p>}
            {a.path && <p className='m-0 mt-2px truncate text-11px text-t-secondary'>{a.path}</p>}
          </div>
        </div>
      ))}
    </div>
  );
};

export default ArtifactList;
