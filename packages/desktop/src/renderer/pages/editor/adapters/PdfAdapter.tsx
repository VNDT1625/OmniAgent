/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `PdfAdapter` — view + edit PDFs (Yêu cầu 2a, criterion 2.4).
 *
 * Office is the default (ONLYOFFICE Docs 7.2+). If Office cannot open, falls
 * back to a read-only viewer using `<webview>` + `file://` URL (Electron-native,
 * no size limit, no bytes in renderer memory). If the webview also fails, shows
 * a clear error with a "Open with system viewer" button.
 *
 * Renderer-only.
 */

import { Alert, Button, Result, Spin } from '@arco-design/web-react';
import { FilePdf } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { EditorAdapterProps } from '../adapterRegistry';
import OnlyOfficeEditor from './OnlyOfficeEditor';
import OnlyOfficeSettingsModal from './OnlyOfficeSettingsModal';
import OfficeFallbackNotice from './OfficeFallbackNotice';

/** Electron webview element interface (subset we need). */
interface ElectronWebView extends HTMLElement {
  src: string;
}

/** did-fail-load event detail from Electron webview. */
interface DidFailLoadEvent extends Event {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
}

type ViewerPhase = 'loading' | 'ready' | 'error';

/**
 * Read-only viewer backed by the embedded Chromium PDF engine.
 * Uses `<webview>` + `file://` URL — Chromium streams from disk, no size limit.
 * Shows a clear error (on screen + console) if the webview fails to load.
 */
const PdfViewer: React.FC<{ filePath: string }> = ({ filePath }) => {
  const { t } = useTranslation();
  const webviewRef = useRef<ElectronWebView>(null);
  const [phase, setPhase] = useState<ViewerPhase>('loading');
  const [errorDetail, setErrorDetail] = useState<string>('');

  // Build file:// URL — handles Windows backslashes and spaces.
  const normalized = filePath.replace(/\\/g, '/');
  const src = `file://${encodeURI(normalized.startsWith('/') ? normalized : `/${normalized}`)}`;

  useEffect(() => {
    setPhase('loading');
    setErrorDetail('');

    const webview = webviewRef.current;
    if (!webview) {
      // webview ref not yet attached — wait for next render cycle.
      const timer = setTimeout(() => {
        if (!webviewRef.current) {
          const msg = 'webview element not mounted — webviewTag may not be enabled in BrowserWindow.';
          console.error('[PdfAdapter] viewer error:', msg, { filePath, src });
          setErrorDetail(msg);
          setPhase('error');
        }
      }, 500);
      return () => clearTimeout(timer);
    }

    const handleFinish = (): void => {
      console.log('[PdfAdapter] webview did-finish-load', { filePath, src });
      setPhase('ready');
    };

    const handleFail = (e: Event): void => {
      const ev = e as DidFailLoadEvent;
      // errorCode -3 = ERR_ABORTED (navigation cancelled, not a real error).
      if (ev.errorCode === -3) return;
      const msg = `${ev.errorDescription} (code ${ev.errorCode}) — URL: ${ev.validatedURL}`;
      console.error('[PdfAdapter] webview did-fail-load', {
        filePath,
        src,
        errorCode: ev.errorCode,
        errorDescription: ev.errorDescription,
        validatedURL: ev.validatedURL,
      });
      setErrorDetail(msg);
      setPhase('error');
    };

    webview.addEventListener('did-finish-load', handleFinish);
    webview.addEventListener('did-fail-load', handleFail);
    return () => {
      webview.removeEventListener('did-finish-load', handleFinish);
      webview.removeEventListener('did-fail-load', handleFail);
    };
  }, [filePath, src]);

  return (
    <div className='flex-1 min-h-0 flex flex-col overflow-hidden rd-6px bg-fill-2'>
      {phase === 'loading' && (
        <div className='absolute inset-0 flex-center z-10 bg-fill-2'>
          <Spin tip={t('editor.state.loading')} />
        </div>
      )}
      {phase === 'error' && (
        <Result
          className='flex-1'
          status='error'
          icon={<FilePdf theme='outline' size='32' />}
          title={t('editor.state.errorTitle')}
          subTitle={
            <div className='flex flex-col gap-8px items-center'>
              <Alert
                type='error'
                className='text-left max-w-480px'
                content={
                  <span className='text-12px font-mono break-all'>
                    {errorDetail || 'Unknown error loading PDF viewer.'}
                  </span>
                }
              />
              <span className='text-12px text-t-tertiary'>{t('editor.pdf.openExternal')}</span>
            </div>
          }
          extra={
            <Button type='primary' onClick={() => void ipcBridge.shell.openFile.invoke(filePath)}>
              {t('editor.pdf.openExternal')}
            </Button>
          }
        />
      )}
      {/* Always mount webview so events fire; hide visually when error/loading */}
      <webview
        key={src}
        ref={webviewRef}
        src={src}
        title={t('editor.pdf.viewerTitle')}
        className='w-full h-full'
        style={{ display: phase === 'error' ? 'none' : 'inline-flex' }}
      />
    </div>
  );
};

/** PDF adapter: Office editing by default; auto-falls back to a read-only viewer. */
const PdfAdapter: React.FC<EditorAdapterProps> = ({ filePath }) => {
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [officeKey, setOfficeKey] = useState(0);

  const retryOffice = useCallback(() => {
    setFallbackReason(null);
    setOfficeKey((k) => k + 1);
  }, []);

  if (fallbackReason === null) {
    return (
      <div className='flex flex-col h-full w-full'>
        <OnlyOfficeEditor key={officeKey} filePath={filePath} onFatalError={(reason) => setFallbackReason(reason)} />
      </div>
    );
  }

  return (
    <div className='flex flex-col h-full w-full gap-8px'>
      <OfficeFallbackNotice reason={fallbackReason} onRetry={retryOffice} onSettings={() => setSettingsOpen(true)} />
      <PdfViewer filePath={filePath} />
      <OnlyOfficeSettingsModal visible={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={retryOffice} />
    </div>
  );
};

export default PdfAdapter;
