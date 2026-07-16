/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `StudioPeerView` — the editor surface for a participant who JOINED a host's
 * shared document (real-time co-editing). Unlike {@link StudioEditorView} the
 * peer has no local file: it mounts {@link OnlyOfficeEditor} in `joinData` mode,
 * pointed at the HOST's Document Server + document key, so ONLYOFFICE merges
 * everyone's edits live. A presence strip polls the host for participants.
 *
 * Renderer-only.
 */

import { Button, Tooltip } from '@arco-design/web-react';
import { Left, People } from '@icon-park/react';
import React, { Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchParticipants,
  type CollabJoinData,
  type CollabParticipant,
} from '@renderer/pages/editor/adapters/collabClient';

const OnlyOfficeEditor = React.lazy(() => import('@renderer/pages/editor/adapters/OnlyOfficeEditor'));

type StudioPeerViewProps = {
  /** Editor config returned by the host on join. */
  join: CollabJoinData;
  /** Base URL of the host (to poll presence): `http://<ip>:<port>`. */
  hostBaseUrl: string;
  onBack: () => void;
};

const StudioPeerView: React.FC<StudioPeerViewProps> = ({ join, hostBaseUrl, onBack }) => {
  const { t } = useTranslation();
  const [participants, setParticipants] = useState<CollabParticipant[]>([]);

  useEffect(() => {
    let alive = true;
    const poll = async (): Promise<void> => {
      const list = await fetchParticipants(join.shareId, hostBaseUrl);
      if (alive) setParticipants(list);
    };
    void poll();
    const timer = setInterval(() => void poll(), 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [join.shareId, hostBaseUrl]);

  return (
    <div className='size-full flex flex-col min-h-0 bg-1'>
      <header className='shrink-0 flex items-center gap-12px px-16px h-52px border-b border-b-1'>
        <Button type='text' icon={<Left theme='outline' size={18} />} className='!text-t-secondary' onClick={onBack}>
          {t('studio.action.back')}
        </Button>
        <span className='text-14px font-[500] text-t-primary truncate'>{join.title}</span>
        <span className='text-12px text-success inline-flex items-center gap-4px'>
          <People theme='outline' size={13} />
          {t('studio.collab.joinedBadge')}
        </span>
        <div className='flex-1' />
        <PresenceStrip participants={participants} />
      </header>
      <div className='flex-1 min-h-0 p-16px'>
        <Suspense fallback={null}>
          <OnlyOfficeEditor
            filePath={join.title}
            joinData={{
              documentServerUrl: join.documentServerUrl,
              documentType: join.documentType,
              fileType: join.fileType,
              title: join.title,
              documentKey: join.documentKey,
              downloadUrl: join.downloadUrl,
              callbackUrl: join.callbackUrl,
            }}
            user={{ id: join.participant.id, name: join.participant.name }}
          />
        </Suspense>
      </div>
    </div>
  );
};

/** A row of participant avatars for the live session. */
const PresenceStrip: React.FC<{ participants: CollabParticipant[] }> = ({ participants }) => {
  if (participants.length === 0) return null;
  return (
    <div className='flex items-center -space-x-6px'>
      {participants.slice(0, 6).map((p) => (
        <span
          key={p.id}
          title={p.name}
          className='size-24px rd-full flex-center text-11px font-600 text-white border-2 border-solid border-bg-2'
          style={{ backgroundColor: p.color }}
        >
          {p.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
    </div>
  );
};

export default StudioPeerView;
