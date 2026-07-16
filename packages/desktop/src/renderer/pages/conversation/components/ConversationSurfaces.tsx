/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The **"Super"** control that lives in the conversation header.
 *
 * Turning Super ON grants the conversation's agent (Claude Code / ACP, aionrs, …)
 * the Browser-Control tool set, so the agent can decide — on its own, while you
 * chat normally — to open a live embedded browser tab and operate the web for
 * you. Turning it OFF removes those tools and the chat behaves exactly as before.
 *
 * This component only renders the header chrome: the Super switch + a "Watch"
 * toggle. The actual live-browser frames render INSIDE the chat column (see
 * {@link ConversationWatchOverlay}); this header just flips them on/off via the
 * `super.watch.toggle` emitter event so they appear "in the conversation"
 * rather than glued to the window edge.
 *
 * Relies on the native browser bridge + `WebContentsView`, so it renders only on
 * the desktop app. Renderer-only module: no Node.js APIs.
 */

import { isElectronDesktop } from '@/renderer/utils/platform';
import type { TChatConversation } from '@/common/config/storage';
import { emitter, useAddEventListener } from '@/renderer/utils/emitter';
import { Button, Message, Switch, Tooltip } from '@arco-design/web-react';
import { Lightning, PlayOne } from '@icon-park/react';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSuperMode } from '../hooks/useSuperMode';

/** Props for {@link ConversationSurfaces}. */
export type ConversationSurfacesProps = {
  /** The host conversation (used for the Super toggle target). */
  conversation?: TChatConversation;
};

/**
 * The Super switch + a Watch toggle, mounted in the conversation header.
 * Desktop-only. The Watch button toggles the in-chat live-browser overlay via
 * the `super.watch.toggle` event (the overlay itself lives in the chat column).
 */
const ConversationSurfaces: React.FC<ConversationSurfacesProps> = ({ conversation }) => {
  const { t } = useTranslation();
  const conversationId = conversation?.id;
  const sup = useSuperMode(conversationId);
  // Mirror the overlay's open state so the button reflects it. The overlay is
  // the source of truth (it also auto-opens); we sync via the toggle/state events.
  const [watching, setWatching] = useState(false);

  // The overlay announces its open state so the header button stays in sync
  // (e.g. when it auto-opens on the agent's first tab, or closes on Escape).
  useAddEventListener(
    'super.watch.state',
    (id: string, open: boolean) => {
      if (id === conversationId) setWatching(open);
    },
    [conversationId]
  );

  const toggleWatch = useCallback(() => {
    if (conversationId) emitter.emit('super.watch.toggle', conversationId);
  }, [conversationId]);

  const handleToggle = useCallback(
    async (next: boolean): Promise<void> => {
      await sup.toggle(next);
      if (sup.error) {
        Message.error(t('workspace.super.toggleError'));
        return;
      }
      Message.success(next ? t('workspace.super.enabled') : t('workspace.super.disabled'));
      // Turning Super OFF closes the overlay (the overlay handles auto-open).
      if (!next && conversationId) emitter.emit('super.watch.set', conversationId, false);
    },
    [sup, t, conversationId]
  );

  // Native WebContentsView surfaces only work in the Electron desktop app.
  if (!isElectronDesktop()) return null;
  // Until the Browser-Control server is registered (boot migration), hide the
  // control rather than offering a switch that cannot do anything.
  if (!sup.available || !conversationId) return null;

  return (
    <>
      <Tooltip content={sup.enabled ? t('workspace.super.onHint') : t('workspace.super.offHint')} position='bottom'>
        <span className='flex items-center gap-6px h-28px px-10px rd-8px bg-fill-1'>
          <Lightning theme='outline' size='14' className={sup.enabled ? 'text-primary' : 'text-t-secondary'} />
          <span className='text-12px text-t-secondary whitespace-nowrap'>{t('workspace.super.label')}</span>
          <Switch size='small' checked={sup.enabled} loading={sup.pending} onChange={handleToggle} />
        </span>
      </Tooltip>
      {sup.enabled && (
        <Tooltip content={t('workspace.watchHint')} position='bottom'>
          <Button
            size='mini'
            type={watching ? 'primary' : 'secondary'}
            icon={<PlayOne theme='outline' size='14' />}
            onClick={toggleWatch}
          >
            {t('workspace.watch')}
          </Button>
        </Tooltip>
      )}
    </>
  );
};

export default ConversationSurfaces;
