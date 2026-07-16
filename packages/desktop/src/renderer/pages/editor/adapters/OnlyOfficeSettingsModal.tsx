/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `OnlyOfficeSettingsModal` — lets the user set the ONLYOFFICE Document Server
 * URL used for full Office editing. The Document Server runs separately (e.g. a
 * Docker container); this only stores the base URL the editor connects to.
 *
 * Renderer-only.
 */

import { Input, Modal, Typography } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getDocumentServerUrl, setDocumentServerUrl } from './onlyOfficeClient';

type OnlyOfficeSettingsModalProps = {
  visible: boolean;
  onClose: () => void;
  /** Called after a non-empty URL is saved (so the caller can retry editing). */
  onSaved?: () => void;
};

const OnlyOfficeSettingsModal: React.FC<OnlyOfficeSettingsModalProps> = ({ visible, onClose, onSaved }) => {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');

  useEffect(() => {
    if (visible) setUrl(getDocumentServerUrl());
  }, [visible]);

  const handleOk = (): void => {
    setDocumentServerUrl(url);
    onClose();
    if (url.trim().length > 0) onSaved?.();
  };

  return (
    <Modal
      title={t('editor.onlyoffice.settingsTitle')}
      visible={visible}
      onCancel={onClose}
      onOk={handleOk}
      okText={t('editor.onlyoffice.save')}
      cancelText={t('editor.onlyoffice.cancel')}
      unmountOnExit
    >
      <Typography.Paragraph className='!text-13px !text-t-secondary'>
        {t('editor.onlyoffice.settingsHint')}
      </Typography.Paragraph>
      <Input value={url} onChange={setUrl} placeholder='http://localhost:8080' allowClear />
      <Typography.Paragraph className='!text-12px !text-t-tertiary !mt-8px !mb-0'>
        {t('editor.onlyoffice.dockerHint')}
      </Typography.Paragraph>
    </Modal>
  );
};

export default OnlyOfficeSettingsModal;
