/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `OnlyOfficeEditor` — full WYSIWYG editing for Word/Excel/PowerPoint via an
 * ONLYOFFICE Document Server (Yêu cầu 2a, "thật sự dùng được, không chắp vá").
 *
 * Flow:
 *  1. Ask the Main process to start an on-demand integration session for the
 *     file ({@link startOfficeEdit}) — this serves the bytes to Document Server
 *     and receives the saved file back.
 *  2. Load the Document Server's `api.js` and mount `DocsAPI.DocEditor` pointed
 *     at our session URLs. The user edits in a real Office-grade editor; saving
 *     round-trips the edited `.docx/.xlsx/.pptx` back to disk via the callback.
 *  3. On unmount, destroy the editor and end the session (host idles down).
 *
 * The Document Server runs separately (not bundled — ~GB). Its URL is a Studio
 * setting; when unset, the caller shows setup guidance instead of this editor.
 *
 * Renderer-only.
 */

import { Result, Spin } from '@arco-design/web-react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ensureDocumentServer,
  getDocumentServerUrl,
  startOfficeEdit,
  stopOfficeEdit,
  type EnsureServerResult,
} from './onlyOfficeClient';
import {
  registerConnector,
  unregisterConnector,
  type OnlyOfficeConnector,
  type OfficeDocKind,
} from './onlyOfficeConnector';

/** Minimal typing for the global `DocsAPI` the Document Server's api.js installs. */
type DocEditorInstance = {
  destroyEditor?: () => void;
  createConnector?: () => OnlyOfficeConnector;
};
type DocsApiGlobal = {
  DocEditor: new (id: string, config: Record<string, unknown>) => DocEditorInstance;
};

/** Map a file extension to the ONLYOFFICE documentType. */
const documentTypeFor = (fileType: string): 'word' | 'cell' | 'slide' | 'pdf' | null => {
  if (['docx', 'doc', 'odt', 'rtf', 'txt'].includes(fileType)) return 'word';
  if (['xlsx', 'xls', 'ods', 'csv'].includes(fileType)) return 'cell';
  if (['pptx', 'ppt', 'odp'].includes(fileType)) return 'slide';
  // ONLYOFFICE Docs (7.2+) opens PDFs in its PDF editor: view, annotate, add
  // text/shapes, sign, and fill forms. Older servers open it read-only.
  if (fileType === 'pdf') return 'pdf';
  return null;
};

/**
 * Decode an ONLYOFFICE editor `onError` event payload into a human-readable
 * reason. The editor's `event.data` is usually a NEGATIVE error code, not text,
 * so a raw passthrough would show a meaningless "-4". Map the common codes.
 * Ref: ONLYOFFICE Docs API error codes.
 */
const describeEditorError = (data: unknown): string => {
  if (typeof data === 'string' && data.trim().length > 0) return data;
  const code = typeof data === 'number' ? data : Number((data as { errorCode?: unknown })?.errorCode);
  const map: Record<number, string> = {
    [-1]: 'Unknown editor error',
    [-2]: 'Conversion timeout — the document is too large or complex for the Document Server',
    [-3]: 'Conversion/download error — the Document Server could not fetch or convert the file (often a size limit or unreachable host)',
    [-4]: 'Download error — the Document Server could not download the file from the integration host (size limit / network)',
    [-5]: 'Unsupported document format',
    [-6]: 'Invalid document — the file is corrupted or password-protected',
    [-8]: 'Invalid JWT token',
    [-20]: 'Memory limit exceeded while converting the document (file too large)',
  };
  if (Number.isFinite(code) && map[code]) return `${map[code]} [code ${code}]`;
  if (Number.isFinite(code)) return `Editor error [code ${code}]`;
  return 'Editor error';
};

/** Load the Document Server api.js once; resolves when `window.DocsAPI` exists. */
const loadDocsApi = (documentServerUrl: string): Promise<DocsApiGlobal> =>
  new Promise((resolve, reject) => {
    const existing = (window as unknown as { DocsAPI?: DocsApiGlobal }).DocsAPI;
    if (existing) {
      resolve(existing);
      return;
    }
    const src = `${documentServerUrl}/web-apps/apps/api/documents/api.js`;
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      const api = (window as unknown as { DocsAPI?: DocsApiGlobal }).DocsAPI;
      if (api) resolve(api);
      else reject(new Error('Document Server loaded but DocsAPI is unavailable.'));
    };
    script.onerror = () => reject(new Error(`Could not load the Document Server at ${documentServerUrl}.`));
    document.head.appendChild(script);
  });

let editorSeq = 0;

/** Props for {@link OnlyOfficeEditor}. */
export type OnlyOfficeEditorProps = {
  /** Absolute path of the file to edit (host/local mode). */
  filePath: string;
  /**
   * When set, mount as a COLLABORATION PEER using this pre-resolved config from
   * the host (instead of starting a local session). The path is unused then.
   */
  joinData?: {
    documentServerUrl: string;
    documentType: 'word' | 'cell' | 'slide';
    fileType: string;
    title: string;
    documentKey: string;
    downloadUrl: string;
    callbackUrl: string;
  };
  /** Display identity for live cursors (co-editing presence). */
  user?: { id: string; name: string };
  /**
   * When provided, the editor reports an unrecoverable failure here INSTEAD of
   * rendering its built-in error screen. Host adapters use this to auto-switch
   * to their lightweight fallback editor (Office is the default; if it can't
   * open, the user still gets a usable editor).
   */
  onFatalError?: (reason: string) => void;
};

/**
 * Mount a full ONLYOFFICE editor for `filePath`. Manages the on-demand session
 * lifecycle and editor teardown.
 */
const OnlyOfficeEditor: React.FC<OnlyOfficeEditorProps> = ({ filePath, joinData, user, onFatalError }) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [statusMsg, setStatusMsg] = useState<'resolving' | 'connecting'>('resolving');
  const [error, setError] = useState<string | null>(null);
  const [holderId] = useState(() => `onlyoffice-holder-${++editorSeq}`);
  const editorRef = useRef<DocEditorInstance | null>(null);
  const tokenRef = useRef<string | null>(null);
  // Keep the latest callback in a ref so the boot effect doesn't re-run when the
  // parent passes a new closure each render.
  const onFatalErrorRef = useRef(onFatalError);
  onFatalErrorRef.current = onFatalError;

  // Surface an unrecoverable failure: prefer delegating to the parent (so a host
  // adapter can fall back to its lightweight editor); otherwise show the screen.
  const fail = (message: string): void => {
    // Always log the exact reason so it's visible in DevTools even when a parent
    // adapter swallows the error screen and shows a fallback instead.
    console.error('[OnlyOfficeEditor] fatal:', message, { filePath, joinMode: Boolean(joinData) });
    if (onFatalErrorRef.current) {
      onFatalErrorRef.current(message);
      return;
    }
    setError(message);
    setStatus('error');
  };

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    setStatusMsg('resolving');
    setError(null);

    const boot = async (): Promise<void> => {
      // ----- COLLABORATION PEER MODE: use the host-provided config as-is. -----
      if (joinData) {
        setStatusMsg('connecting');
        const api = await loadDocsApi(joinData.documentServerUrl);
        if (!alive) return;
        const peerConfig = {
          documentType: joinData.documentType,
          type: 'desktop',
          width: '100%',
          height: '100%',
          document: {
            fileType: joinData.fileType,
            key: joinData.documentKey,
            title: joinData.title,
            url: joinData.downloadUrl,
            permissions: { edit: true, download: true },
          },
          editorConfig: {
            mode: 'edit',
            lang: 'vi',
            callbackUrl: joinData.callbackUrl,
            user: user ? { id: user.id, name: user.name } : undefined,
            customization: { autosave: true, forcesave: true, compactToolbar: false },
          },
          events: {
            onError: (event: { data?: unknown }) => {
              if (alive) fail(describeEditorError(event?.data));
            },
          },
        };
        editorRef.current = new api.DocEditor(holderId, peerConfig);
        if (alive) setStatus('ready');
        return;
      }

      // ----- HOST / LOCAL MODE: resolve a Document Server, start a session. -----
      // Resolve a Document Server: configured URL if reachable, else start the
      // managed Docker container on demand. This is the "chỉ gọi ra khi dùng tới".
      setStatusMsg('resolving');
      const resolved = await ensureDocumentServer(getDocumentServerUrl() || undefined);
      if (!alive) return;
      if (!resolved.ok) {
        // strictNullChecks is off in the root tsconfig, so TS does not narrow the
        // `{ ok: false }` branch of the union; cast locally to read `reason`.
        throw new Error(`SERVER:${(resolved as Extract<EnsureServerResult, { ok: false }>).reason}`);
      }
      const ok = resolved as Extract<EnsureServerResult, { ok: true }>;
      const documentServerUrl = ok.url;
      // Note: a managed (Docker) server URL is intentionally NOT persisted —
      // persisting it would make it look "configured" and skip the managed
      // reconcile (JWT-disabled + host.docker.internal) on later opens.

      // 1) Start the on-demand integration session (serves file + save callback).
      //    When the Document Server is our managed Docker container, it must reach
      //    the integration host via `host.docker.internal` (127.0.0.1 inside the
      //    container points at the container itself, not the host machine).
      setStatusMsg('connecting');
      const advertisedHost = ok.managed ? 'host.docker.internal' : undefined;
      const session = await startOfficeEdit(filePath, advertisedHost);
      if (!alive) {
        void stopOfficeEdit(session.token);
        return;
      }
      tokenRef.current = session.token;

      const documentType = documentTypeFor(session.fileType);
      if (!documentType) {
        throw new Error(`Unsupported file type for editing: .${session.fileType}`);
      }

      // 2) Load api.js and mount the editor.
      const api = await loadDocsApi(documentServerUrl);
      if (!alive) return;

      const config = {
        documentType,
        type: 'desktop',
        width: '100%',
        height: '100%',
        document: {
          fileType: session.fileType,
          key: session.documentKey,
          title: session.title,
          url: session.downloadUrl,
          permissions: { edit: true, download: true },
        },
        editorConfig: {
          mode: 'edit',
          lang: 'vi',
          callbackUrl: session.callbackUrl,
          user: user ? { id: user.id, name: user.name } : undefined,
          customization: { autosave: true, forcesave: true, compactToolbar: false },
        },
        events: {
          onDocumentReady: () => {
            // Open an Automation API connector so the Studio AI agent can drive
            // this live editor with fast, local tool calls (read/replace/insert).
            // The PDF editor has no document-text Automation API, so skip it.
            if (documentType === 'pdf') return;
            try {
              const instance = editorRef.current;
              const connector = instance?.createConnector?.();
              if (connector) {
                registerConnector(filePath, connector as OnlyOfficeConnector, documentType as OfficeDocKind);
                console.log('[OnlyOfficeEditor] AI connector registered — agent tools enabled.', {
                  filePath,
                  documentType,
                });
              } else {
                // No connector: the running Document Server build does not expose
                // the Automation API (`createConnector`). The agent's live tools
                // won't work; the panel falls back to chat mode.
                console.warn(
                  '[OnlyOfficeEditor] createConnector() returned nothing — this Document Server build does not expose the Automation API, so AI agent tools are unavailable (chat-only).',
                  { filePath, documentType, hasCreateConnector: typeof instance?.createConnector }
                );
              }
            } catch (cause) {
              console.error('[OnlyOfficeEditor] createConnector() threw — AI agent tools unavailable.', cause);
            }
          },
          onError: (event: { data?: unknown }) => {
            if (alive) fail(describeEditorError(event?.data));
          },
        },
      };

      editorRef.current = new api.DocEditor(holderId, config);
      if (alive) setStatus('ready');
    };

    boot().catch((cause: unknown) => {
      if (!alive) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      fail(message);
    });

    return () => {
      alive = false;
      unregisterConnector(filePath);
      try {
        editorRef.current?.destroyEditor?.();
      } catch {
        /* ignore teardown errors */
      }
      editorRef.current = null;
      if (tokenRef.current) {
        void stopOfficeEdit(tokenRef.current);
        tokenRef.current = null;
      }
    };
  }, [filePath, holderId, joinData, user]);

  if (status === 'error') {
    // SERVER:<reason> errors map to a friendly hint; others show the raw message.
    const serverReason = error?.startsWith('SERVER:') ? error.slice('SERVER:'.length) : null;
    const isInfo = serverReason === 'docker-missing' || serverReason === 'docker-stopped';
    const subTitle = serverReason ? t(`editor.onlyoffice.reason.${serverReason}`) : (error ?? undefined);
    return (
      <Result
        status={isInfo ? 'info' : 'error'}
        title={isInfo ? t('editor.onlyoffice.noServerTitle') : t('editor.onlyoffice.failedTitle')}
        subTitle={subTitle}
      />
    );
  }

  return (
    <div className='relative flex-1 min-h-0 w-full'>
      {status === 'loading' ? (
        <div className='absolute inset-0 flex-center flex-col gap-8px z-10'>
          <Spin
            tip={statusMsg === 'resolving' ? t('editor.onlyoffice.resolving') : t('editor.onlyoffice.connecting')}
          />
          {statusMsg === 'resolving' ? (
            <span className='text-12px text-t-tertiary max-w-280px text-center'>
              {t('editor.onlyoffice.startingHint')}
            </span>
          ) : null}
        </div>
      ) : null}
      <div id={holderId} className='h-full w-full' />
    </div>
  );
};

export default OnlyOfficeEditor;
