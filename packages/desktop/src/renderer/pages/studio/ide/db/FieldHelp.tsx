/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `FieldHelp` — a small "?" affordance shown next to a connection-form label. It
 * surfaces a plain-language hint on hover and, when a `url` is given, opens the
 * exact dashboard / docs page where that value lives (via the external browser).
 *
 * Renderer-only; Arco Tooltip + icon-park `Help`; opens links through
 * {@link openExternalUrl} so it works in both Electron and the WebUI.
 */

import { Tooltip } from '@arco-design/web-react';
import { Help } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { openExternalUrl } from '@/renderer/utils/platform';

type FieldHelpProps = {
  /** Already-translated hint describing what the value is / where it comes from. */
  tooltip: string;
  /** When set, clicking the icon opens this page in the external browser. */
  url?: string;
};

const FieldHelp: React.FC<FieldHelpProps> = ({ tooltip, url }) => {
  const { t } = useTranslation();
  const open = (): void => {
    if (url) void openExternalUrl(url).catch((): undefined => undefined);
  };
  const content = url ? (
    <span className='flex flex-col gap-2px'>
      <span>{tooltip}</span>
      <span className='text-11px text-primary'>{t('ide.db.help.learnMore')}</span>
    </span>
  ) : (
    tooltip
  );
  return (
    <Tooltip content={content} position='top'>
      <Help
        theme='outline'
        size={13}
        className={`text-t-tertiary hover:text-primary ${url ? 'cursor-pointer' : 'cursor-help'}`}
        onClick={open}
      />
    </Tooltip>
  );
};

export default FieldHelp;
