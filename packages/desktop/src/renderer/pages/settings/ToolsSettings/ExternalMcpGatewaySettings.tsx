/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Settings panel for the Omni External MCP Gateway.
 *
 * Lets the user enable/disable the loopback gateway, pick a workspace folder
 * for external sessions, change the loopback port, reveal/copy/regenerate the
 * bearer token, and opt into the dangerous-tools allowlist. Provides a ready
 * mcp.json snippet for Claude Desktop / Cursor.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Input,
  InputNumber,
  Message,
  Modal,
  Radio,
  Select,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
} from '@arco-design/web-react';
import { Copy, FolderOpen, Help, LinkCloud, Refresh, Unlink } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import {
  dialog,
  omniGateway,
  type OmniAuthMode,
  type OmniGatewayProgressEvent,
  type OmniGatewayProgressPhase,
  type OmniGatewayStatusDto,
  type RemoteAccessMode,
} from '@/common/adapter/ipcBridge';
import { OMNI_IDE_BASE_ALLOWLIST, OMNI_IDE_DANGEROUS_TOOLS } from '@process/omni-gateway/omniIdeAllowlist';
import {
  joinRemotePath,
  resolveRemoteEndpoints,
  validatePublicBaseUrl,
  type RemoteUrlValidationCode,
} from '@/common/config/remotePublicUrl';

/**
 * Phases that mean "something is happening, keep showing the progress strip".
 * `ready`, `failed`, `stopped`, and `idle` are terminal — we render them once
 * (or not at all for `idle`) and then let the user dismiss / move on.
 */
const INFLIGHT_PHASES: ReadonlySet<OmniGatewayProgressPhase> = new Set<OmniGatewayProgressPhase>([
  'checking-cloudflared',
  'installing-cloudflared',
  'minting-token',
  'spawning-tunnel',
  'waiting-tunnel-url',
  'stopping',
]);

/** Tailwind/UnoCSS color for the progress strip per phase category. */
const phaseTone = (phase: OmniGatewayProgressPhase): 'sky' | 'green' | 'red' | 'gray' => {
  if (phase === 'failed') return 'red';
  if (phase === 'ready') return 'green';
  if (phase === 'stopped' || phase === 'idle') return 'gray';
  return 'sky';
};

const DEFAULT_STATUS: OmniGatewayStatusDto = {
  enabled: false,
  running: false,
  port: 47821,
  rootPath: undefined,
  allowDangerous: false,
  ideSseUrl: undefined,
  ideMcpUrl: undefined,
  hasToken: false,
  tokenCreatedAt: undefined,
  tokenLastRotatedAt: undefined,
  lastError: undefined,
  remote: { mode: 'quick' },
};

type DebugAccess = {
  token: string;
  expiresAt: number;
  healthUrl: string;
  bootstrapUrl: string;
};

const buildMcpJsonSnippet = (url: string | undefined, hasToken: boolean): string => {
  const resolvedUrl = url ?? 'http://127.0.0.1:47821/ide/sse';
  return JSON.stringify(
    {
      mcpServers: {
        'aionui-omni-ide': {
          transport: 'sse',
          url: resolvedUrl,
          headers: { Authorization: hasToken ? 'Bearer <PASTE_TOKEN>' : 'Bearer <ENABLE_GATEWAY_FIRST>' },
        },
      },
    },
    null,
    2
  );
};

const ExternalMcpGatewaySettings: React.FC = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<OmniGatewayStatusDto>(DEFAULT_STATUS);
  const [busy, setBusy] = useState(false);
  const [revealedToken, setRevealedToken] = useState<string | undefined>(undefined);
  const [webToken, setWebToken] = useState<string | undefined>(undefined);
  const [debugAccess, setDebugAccess] = useState<DebugAccess | undefined>(undefined);
  const [portDraft, setPortDraft] = useState<number>(DEFAULT_STATUS.port);
  const [progress, setProgress] = useState<OmniGatewayProgressEvent | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const fresh = await omniGateway.getStatus.invoke();
      setStatus(fresh);
      setPortDraft(fresh.port);
    } catch (error) {
      console.error('[ExternalMcpGateway] getStatus failed:', error);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Subscribe to live Web Access progress events so the panel can replace its
  // opaque spinner with per-phase text (cloudflared install ~5–30 s first run,
  // tunnel URL assignment ~5–25 s every run). The tunnel itself runs in the
  // Main process and keeps going even while this panel is unmounted, so on
  // mount we ALSO re-seed from the cached last event — otherwise navigating
  // away mid-startup and back would show nothing and look like it had stopped.
  useEffect(() => {
    let active = true;
    void omniGateway.getProgress.invoke().then((seed) => {
      if (active && seed) setProgress(seed);
    });
    const off = omniGateway.progress.on((event) => {
      setProgress(event);
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  const apply = useCallback(async (patch: Parameters<typeof omniGateway.applyConfig.invoke>[0]) => {
    setBusy(true);
    try {
      const next = await omniGateway.applyConfig.invoke(patch);
      setStatus(next);
      setPortDraft(next.port);
    } catch (error) {
      Message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const handlePickFolder = useCallback(async () => {
    const result = await dialog.showOpen.invoke({ properties: ['openDirectory'] });
    const picked = Array.isArray(result) && result.length > 0 ? result[0] : undefined;
    if (picked) await apply({ rootPath: picked });
  }, [apply]);

  const handleToggleEnabled = useCallback(
    async (enabled: boolean) => {
      await apply({ enabled });
      // Auto-reveal a freshly minted token the first time the user enables.
      if (enabled) {
        const fresh = await omniGateway.revealToken.invoke();
        setRevealedToken(fresh);
      } else {
        setRevealedToken(undefined);
      }
    },
    [apply]
  );

  const handleToggleDangerous = useCallback(
    async (allowDangerous: boolean) => {
      await apply({ allowDangerous });
    },
    [apply]
  );

  const handleCommitPort = useCallback(async () => {
    if (portDraft !== status.port && portDraft >= 1024 && portDraft <= 65535) {
      await apply({ port: portDraft });
    }
  }, [apply, portDraft, status.port]);

  const handleRevealToken = useCallback(async () => {
    if (revealedToken !== undefined) {
      setRevealedToken(undefined);
      return;
    }
    try {
      const token = await omniGateway.revealToken.invoke();
      setRevealedToken(token ?? '');
    } catch (error) {
      Message.error(error instanceof Error ? error.message : String(error));
    }
  }, [revealedToken]);

  const handleCopyToken = useCallback(async () => {
    const token = revealedToken ?? (await omniGateway.revealToken.invoke());
    if (!token) {
      Message.warning(t('externalMcp.token.missing'));
      return;
    }
    await navigator.clipboard.writeText(token);
    Message.success(t('externalMcp.token.copied'));
  }, [revealedToken, t]);

  const handleRotateToken = useCallback(() => {
    Modal.confirm({
      title: t('externalMcp.token.regenerate'),
      content: t('externalMcp.token.confirmRegenerate'),
      okText: t('externalMcp.token.regenerate'),
      onOk: async () => {
        setBusy(true);
        try {
          const { token, status: next } = await omniGateway.rotateToken.invoke();
          setStatus(next);
          setRevealedToken(token);
          Message.success(t('externalMcp.token.copied'));
          await navigator.clipboard.writeText(token);
        } catch (error) {
          Message.error(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      },
    });
  }, [t]);

  const mcpJsonSnippet = useMemo(
    () => buildMcpJsonSnippet(status.ideSseUrl, status.hasToken),
    [status.ideSseUrl, status.hasToken]
  );

  const handleCopySnippet = useCallback(async () => {
    await navigator.clipboard.writeText(mcpJsonSnippet);
    Message.success(t('externalMcp.token.copied'));
  }, [mcpJsonSnippet, t]);

  const handleEnableWebAccess = useCallback(async () => {
    setBusy(true);
    // Drive the progress strip from LOCAL state immediately so the user always
    // sees feedback on click — the Main-process `progress` IPC events only make
    // the phase MORE granular; we never depend on them showing up. A timer
    // walks the optimistic phases so a slow tunnel startup still looks alive.
    setProgress({ phase: 'checking-cloudflared', at: Date.now() });
    const optimistic: OmniGatewayProgressPhase[] = ['spawning-tunnel', 'waiting-tunnel-url'];
    let step = 0;
    const ticker = window.setInterval(() => {
      if (step < optimistic.length) {
        setProgress({ phase: optimistic[step], at: Date.now() });
        step += 1;
      }
    }, 1200);
    // Client-side watchdog: the Main-process tunnel start has its own 40 s
    // ceiling, but if the IPC round-trip itself never resolves (e.g. a stale
    // dev Main process running old code), we must NOT spin forever. After 90 s
    // we surface a clear, actionable failure instead of an endless spinner.
    const watchdog = new Promise<never>((_, reject) =>
      window.setTimeout(() => reject(new Error(t('externalMcp.web.timeout'))), 90000)
    );
    try {
      const result = await Promise.race([omniGateway.enableWebAccess.invoke(), watchdog]);
      window.clearInterval(ticker);
      setStatus(result.status);
      setWebToken(result.token);
      setDebugAccess(undefined);
      if (!result.status.externalMode?.running) {
        const error = result.status.lastError ?? t('externalMcp.web.startFailed');
        setProgress({ phase: 'failed', at: Date.now(), error });
        Message.error(error);
        return;
      }
      setProgress({ phase: 'ready', at: Date.now(), tunnelUrl: result.status.externalMode?.tunnelUrl });
      Message.success(t('externalMcp.web.started'));
    } catch (error) {
      window.clearInterval(ticker);
      const message = error instanceof Error ? error.message : String(error);
      setProgress({ phase: 'failed', at: Date.now(), error: message });
      Message.error(message);
    } finally {
      setBusy(false);
    }
  }, [t]);

  const handleDisableWebAccess = useCallback(async () => {
    setBusy(true);
    setProgress({ phase: 'stopping', at: Date.now() });
    try {
      const next = await omniGateway.disableWebAccess.invoke();
      setStatus(next);
      setWebToken(undefined);
      setDebugAccess(undefined);
      setProgress({ phase: 'stopped', at: Date.now() });
      Message.success(t('externalMcp.web.stopped'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProgress({ phase: 'failed', at: Date.now(), error: message });
      Message.error(message);
    } finally {
      setBusy(false);
    }
  }, [t]);

  const handleCreateDebugAccess = useCallback(async () => {
    setBusy(true);
    try {
      const result = await omniGateway.createDebugAccess.invoke();
      setStatus(result.status);
      setDebugAccess(result);
      Message.success(t('externalMcp.web.debugCreated'));
    } catch (error) {
      Message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const handleRevokeDebugAccess = useCallback(async () => {
    setBusy(true);
    try {
      const next = await omniGateway.revokeDebugAccess.invoke();
      setStatus(next);
      setDebugAccess(undefined);
      Message.success(t('externalMcp.web.debugRevoked'));
    } catch (error) {
      Message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const handleSetRemoteMode = useCallback(async (mode: RemoteAccessMode) => {
    setBusy(true);
    try {
      const next = await omniGateway.setRemoteAccess.invoke({ mode });
      setStatus(next);
    } catch (error) {
      Message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleSaveStableUrls = useCallback(
    async (mcpBaseUrl: string, webuiBaseUrl: string) => {
      setBusy(true);
      try {
        const next = await omniGateway.setRemoteAccess.invoke({
          stableMcpBaseUrl: mcpBaseUrl.trim().length > 0 ? mcpBaseUrl : null,
          stableWebuiBaseUrl: webuiBaseUrl.trim().length > 0 ? webuiBaseUrl : null,
        });
        setStatus(next);
        Message.success(t('externalMcp.remote.setup.saved'));
      } catch (error) {
        Message.error(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [t]
  );

  const handleSetAuthMode = useCallback(async (mode: OmniAuthMode) => {
    setBusy(true);
    try {
      const next = await omniGateway.setAuthMode.invoke({ mode });
      setStatus(next);
    } catch (error) {
      Message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleCommitTtl = useCallback(
    async (hours: number) => {
      const ttlMs = Math.round(hours * 60 * 60 * 1000);
      if (ttlMs === status.auth?.sessionTtlMs) return;
      setBusy(true);
      try {
        const next = await omniGateway.setSessionTtl.invoke({ ttlMs });
        setStatus(next);
      } catch (error) {
        Message.error(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [status.auth?.sessionTtlMs]
  );

  const handleSetToolPermission = useCallback(async (toolName: string, allowed: boolean | null) => {
    setBusy(true);
    try {
      const next = await omniGateway.setToolPermission.invoke({ toolName, allowed });
      setStatus(next);
    } catch (error) {
      Message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleRevokeOAuthClient = useCallback(
    (clientId: string) => {
      Modal.confirm({
        title: t('externalMcp.auth.oauth.revokeTitle'),
        content: t('externalMcp.auth.oauth.revokeConfirm'),
        okText: t('externalMcp.auth.oauth.revoke'),
        okButtonProps: { status: 'danger' },
        onOk: async () => {
          setBusy(true);
          try {
            const next = await omniGateway.revokeOAuthClient.invoke({ clientId });
            setStatus(next);
            Message.success(t('externalMcp.auth.oauth.revoked'));
          } catch (error) {
            Message.error(error instanceof Error ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        },
      });
    },
    [t]
  );

  const copyValue = useCallback(
    async (value: string | undefined) => {
      if (!value) return;
      await navigator.clipboard.writeText(value);
      Message.success(t('externalMcp.token.copied'));
    },
    [t]
  );

  const statusColor: 'green' | 'red' | 'gray' = status.running ? 'green' : status.lastError ? 'red' : 'gray';
  const statusLabel = status.lastError
    ? t('externalMcp.status.error')
    : status.running
      ? t('externalMcp.status.running')
      : t('externalMcp.status.stopped');

  // Web Access is starting up (in the Main process) whenever the latest
  // progress phase is one of the in-flight phases. Derived from progress —
  // not just local `busy` — so the controls still reflect "working…" after the
  // user navigates away during startup and comes back to a freshly mounted panel.
  const webInflight = progress !== undefined && INFLIGHT_PHASES.has(progress.phase);
  const webBusy = busy || webInflight;

  const remoteMode: RemoteAccessMode = status.remote?.mode ?? 'quick';

  return (
    <div className='px-[12px] md:px-[32px] py-[24px] bg-2 rd-12px md:rd-16px border border-border-2 space-y-16px'>
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-8px'>
          <span className='text-14px text-t-primary'>{t('externalMcp.title')}</span>
          <Tag color={statusColor} size='small'>
            {statusLabel}
          </Tag>
        </div>
        <Switch
          checked={status.enabled}
          loading={busy}
          onChange={(checked) => {
            void handleToggleEnabled(Boolean(checked));
          }}
        />
      </div>

      <div className='text-12px text-t-secondary'>{t('externalMcp.description')}</div>

      <Alert type='info' showIcon content={t('externalMcp.internalHint')} />

      {status.lastError ? (
        <div className='text-12px text-red-6 border border-red-3 rd-6px px-12px py-8px'>{status.lastError}</div>
      ) : null}

      {/* Workspace folder */}
      <div className='space-y-4px'>
        <div className='text-12px text-t-primary flex items-center gap-4px'>
          {t('externalMcp.rootPath.label')}
          <Tooltip content={t('externalMcp.rootPath.hint')}>
            <Help theme='outline' size='12' />
          </Tooltip>
        </div>
        <div className='flex items-center gap-8px'>
          <Input
            readOnly
            value={status.rootPath ?? ''}
            placeholder={t('externalMcp.rootPath.empty')}
            className='flex-1'
          />
          <Button icon={<FolderOpen size='14' />} onClick={handlePickFolder} disabled={busy}>
            {t('externalMcp.rootPath.pick')}
          </Button>
        </div>
      </div>

      {/* Port */}
      <div className='space-y-4px'>
        <div className='text-12px text-t-primary flex items-center gap-4px'>
          {t('externalMcp.port')}
          <Tooltip content={t('externalMcp.portHint')}>
            <Help theme='outline' size='12' />
          </Tooltip>
        </div>
        <div className='flex items-center gap-8px'>
          <InputNumber
            value={portDraft}
            min={1024}
            max={65535}
            onChange={(value) => {
              if (typeof value === 'number') setPortDraft(value);
            }}
            disabled={busy}
          />
          <Button
            type='primary'
            disabled={busy || portDraft === status.port || portDraft < 1024 || portDraft > 65535}
            onClick={() => {
              void handleCommitPort();
            }}
          >
            {t('externalMcp.remote.setup.save')}
          </Button>
        </div>
      </div>

      {/* Bearer token */}
      <div className='space-y-4px'>
        <div className='text-12px text-t-primary'>{t('externalMcp.token.label')}</div>
        <div className='flex items-center gap-8px'>
          <Input.Password
            value={revealedToken ?? (status.hasToken ? '••••••••••••••••••••••••••••••••' : '')}
            visibilityToggle={false}
            readOnly
            className='flex-1'
            placeholder={t('externalMcp.token.missing')}
          />
          <Button onClick={handleRevealToken} disabled={!status.hasToken || busy}>
            {revealedToken === undefined ? t('externalMcp.token.reveal') : t('externalMcp.token.hide')}
          </Button>
          <Button icon={<Copy size='14' />} onClick={handleCopyToken} disabled={!status.hasToken || busy}>
            {t('externalMcp.token.copy')}
          </Button>
          <Button icon={<Refresh size='14' />} onClick={handleRotateToken} disabled={busy} status='warning'>
            {t('externalMcp.token.regenerate')}
          </Button>
        </div>
      </div>

      {/* Dangerous tools */}
      <div className='flex items-start justify-between gap-8px'>
        <div className='space-y-4px'>
          <div className='text-12px text-t-primary'>{t('externalMcp.dangerous.label')}</div>
          <div className='text-12px text-t-secondary'>{t('externalMcp.dangerous.hint')}</div>
        </div>
        <Switch
          checked={status.allowDangerous}
          disabled={busy}
          onChange={(checked) => {
            void handleToggleDangerous(Boolean(checked));
          }}
        />
      </div>

      {/* Multi-mode authentication */}
      <AuthSection
        status={status}
        busy={busy}
        t={t}
        onSetAuthMode={handleSetAuthMode}
        onCommitTtl={handleCommitTtl}
        onSetToolPermission={handleSetToolPermission}
        onRevokeOAuthClient={handleRevokeOAuthClient}
        onCopyValue={copyValue}
      />

      {/* mcp.json snippet */}
      <div className='space-y-4px'>
        <div className='flex items-center justify-between'>
          <div className='text-12px text-t-primary'>{t('externalMcp.mcpJson.title')}</div>
          <Button icon={<Copy size='14' />} size='mini' onClick={handleCopySnippet}>
            {t('externalMcp.mcpJson.copy')}
          </Button>
        </div>
        <div className='text-12px text-t-secondary'>{t('externalMcp.mcpJson.hint')}</div>
        <pre className='text-12px bg-1 rd-6px px-12px py-8px overflow-x-auto m-0'>
          <code>{mcpJsonSnippet}</code>
        </pre>
      </div>

      <div className='border-t border-border-2 pt-16px space-y-12px'>
        {/* Remote Access mode selector — Quick (temporary tunnel) vs Setup
            (user-provided stable public URL). Provider-agnostic. */}
        <div className='space-y-8px'>
          <div className='flex items-center gap-8px'>
            <span className='text-14px text-t-primary'>{t('externalMcp.remote.mode.label')}</span>
          </div>
          <Radio.Group
            type='button'
            value={remoteMode}
            disabled={busy}
            onChange={(value) => {
              void handleSetRemoteMode(value as RemoteAccessMode);
            }}
          >
            <Radio value='quick'>{t('externalMcp.remote.mode.quick')}</Radio>
            <Radio value='setup'>{t('externalMcp.remote.mode.setup')}</Radio>
          </Radio.Group>
          <div className='text-12px text-t-secondary'>
            {remoteMode === 'quick' ? t('externalMcp.remote.mode.quickHint') : t('externalMcp.remote.mode.setupHint')}
          </div>
        </div>

        {remoteMode === 'setup' ? (
          <RemoteSetupPanel status={status} busy={busy} t={t} onSave={handleSaveStableUrls} onCopyValue={copyValue} />
        ) : (
          <>
            <div className='flex items-start justify-between gap-12px'>
              <div className='space-y-4px'>
                <div className='flex items-center gap-8px'>
                  <span className='text-14px text-t-primary'>{t('externalMcp.web.title')}</span>
                  <Tag color={status.externalMode?.running ? 'green' : 'gray'} size='small'>
                    {status.externalMode?.running ? t('externalMcp.web.active') : t('externalMcp.web.inactive')}
                  </Tag>
                </div>
                <div className='text-12px text-t-secondary'>{t('externalMcp.web.description')}</div>
              </div>
              <div className='flex items-center gap-8px'>
                {status.externalMode?.running ? (
                  <>
                    <Button
                      icon={<Refresh size='14' />}
                      loading={webBusy}
                      onClick={() => {
                        void handleEnableWebAccess();
                      }}
                    >
                      {t('externalMcp.web.rotate')}
                    </Button>
                    <Button
                      icon={<Unlink size='14' />}
                      status='danger'
                      disabled={webBusy}
                      onClick={() => {
                        void handleDisableWebAccess();
                      }}
                    >
                      {t('externalMcp.web.stop')}
                    </Button>
                  </>
                ) : (
                  <Button
                    type='primary'
                    icon={<LinkCloud size='14' />}
                    loading={webBusy}
                    disabled={!status.running}
                    onClick={() => {
                      void handleEnableWebAccess();
                    }}
                  >
                    {t('externalMcp.web.start')}
                  </Button>
                )}
              </div>
            </div>

            <Alert type='warning' showIcon content={t('externalMcp.web.securityHint')} />

            <Alert type='warning' showIcon content={t('externalMcp.remote.quick.warning')} />

            {progress && progress.phase !== 'idle' ? <ProgressStrip progress={progress} t={t} /> : null}

            {status.externalMode?.running ? (
              <div className='space-y-12px'>
                <div className='space-y-4px'>
                  <div className='text-12px text-t-primary'>{t('externalMcp.web.mcpUrl')}</div>
                  <Input
                    readOnly
                    value={status.externalMode.mcpUrl ?? ''}
                    addAfter={
                      <Button
                        type='text'
                        icon={<Copy size='14' />}
                        onClick={() => {
                          void copyValue(status.externalMode?.mcpUrl);
                        }}
                      />
                    }
                  />
                </div>
                <div className='space-y-4px'>
                  <div className='text-12px text-t-primary'>{t('externalMcp.web.sessionToken')}</div>
                  <Input.Password
                    readOnly
                    visibilityToggle
                    value={webToken ?? t('externalMcp.web.rotateToReveal')}
                    addAfter={
                      <Button
                        type='text'
                        icon={<Copy size='14' />}
                        disabled={!webToken}
                        onClick={() => {
                          void copyValue(webToken);
                        }}
                      />
                    }
                  />
                  <div className='text-12px text-t-secondary'>{t('externalMcp.web.tokenLifetime')}</div>
                </div>

                <div className='bg-1 rd-8px border border-border-2 p-12px space-y-8px'>
                  <div className='flex items-start justify-between gap-12px'>
                    <div>
                      <div className='text-12px text-t-primary'>{t('externalMcp.web.debugTitle')}</div>
                      <div className='text-12px text-t-secondary mt-4px'>{t('externalMcp.web.debugHint')}</div>
                    </div>
                    <div className='flex items-center gap-8px'>
                      <Button
                        size='small'
                        disabled={busy}
                        onClick={() => {
                          void handleCreateDebugAccess();
                        }}
                      >
                        {t('externalMcp.web.createDebug')}
                      </Button>
                      {status.externalMode.debugTokenCount > 0 ? (
                        <Button
                          size='small'
                          status='danger'
                          disabled={busy}
                          onClick={() => {
                            void handleRevokeDebugAccess();
                          }}
                        >
                          {t('externalMcp.web.revokeDebug')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {debugAccess ? (
                    <div className='space-y-8px'>
                      <Input
                        readOnly
                        value={debugAccess.bootstrapUrl}
                        addAfter={
                          <Button
                            type='text'
                            icon={<Copy size='14' />}
                            onClick={() => {
                              void copyValue(debugAccess.bootstrapUrl);
                            }}
                          />
                        }
                      />
                      <div className='text-12px text-t-secondary'>{t('externalMcp.web.debugLimits')}</div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
};

/* __AUTH_SECTION_PLACEHOLDER__ */

/** Default loopback targets shown as reverse-proxy hints in Setup mode. */
const LOCAL_MCP_TARGET = 'http://127.0.0.1:47821';
const LOCAL_WEBUI_TARGET = 'http://127.0.0.1:25809';

/** Map a validation code to its i18n key for inline field feedback. */
const REMOTE_URL_CODE_KEYS: Record<RemoteUrlValidationCode, string> = {
  empty: 'externalMcp.remote.setup.invalidUrl',
  'missing-protocol': 'externalMcp.remote.setup.missingProtocol',
  'invalid-url': 'externalMcp.remote.setup.invalidUrl',
  'unsupported-protocol': 'externalMcp.remote.setup.unsupportedProtocol',
  'path-not-allowed': 'externalMcp.remote.setup.pathNotAllowed',
  'insecure-public-http': 'externalMcp.remote.setup.insecureHttpWarning',
  'temporary-quick-tunnel': 'externalMcp.remote.setup.trycloudflareWarning',
};

/**
 * Setup-mode panel: the user types their OWN stable public base URLs (Cloudflare
 * Named Tunnel, VPS reverse proxy, Tailscale Funnel, ngrok custom domain, …).
 * The app never manages a tunnel here — it validates, persists, and generates
 * copyable endpoints from the saved URLs. Quick-mode controls live in the parent.
 */
const RemoteSetupPanel: React.FC<{
  status: OmniGatewayStatusDto;
  busy: boolean;
  t: (key: string, opts?: Record<string, unknown>) => string;
  onSave: (mcpBaseUrl: string, webuiBaseUrl: string) => void | Promise<void>;
  onCopyValue: (value: string | undefined) => void | Promise<void>;
}> = ({ status, busy, t, onSave, onCopyValue }) => {
  const [mcpDraft, setMcpDraft] = useState<string>(status.remote?.stableMcpBaseUrl ?? '');
  const [webuiDraft, setWebuiDraft] = useState<string>(status.remote?.stableWebuiBaseUrl ?? '');
  const [mcpCodes, setMcpCodes] = useState<RemoteUrlValidationCode[]>([]);
  const [webuiCodes, setWebuiCodes] = useState<RemoteUrlValidationCode[]>([]);

  // Re-seed drafts when the saved status changes (e.g. after reload).
  useEffect(() => {
    setMcpDraft(status.remote?.stableMcpBaseUrl ?? '');
    setWebuiDraft(status.remote?.stableWebuiBaseUrl ?? '');
  }, [status.remote?.stableMcpBaseUrl, status.remote?.stableWebuiBaseUrl]);

  const validateInto = useCallback((value: string, set: (codes: RemoteUrlValidationCode[]) => void) => {
    if (value.trim().length === 0) {
      set([]);
      return;
    }
    set(validatePublicBaseUrl(value).codes);
  }, []);

  const endpoints = useMemo(
    () =>
      resolveRemoteEndpoints({
        mode: 'setup',
        stableBaseUrl: status.remote?.stableMcpBaseUrl,
      }),
    [status.remote?.stableMcpBaseUrl]
  );

  const savedWebui = status.remote?.stableWebuiBaseUrl;
  const savedMcp = status.remote?.stableMcpBaseUrl;
  // A change between the saved MCP URL and the current draft means connectors
  // may need to be updated/recreated — surface a gentle note.
  const mcpChanged = mcpDraft.trim().length > 0 && mcpDraft.trim() !== (savedMcp ?? '');

  const renderFieldNotes = (codes: RemoteUrlValidationCode[]) =>
    codes.length === 0 ? null : (
      <div className='space-y-2px'>
        {codes.map((code) => {
          const isError =
            code === 'empty' ||
            code === 'missing-protocol' ||
            code === 'invalid-url' ||
            code === 'unsupported-protocol' ||
            code === 'path-not-allowed';
          return (
            <div key={code} className={`text-12px ${isError ? 'text-red-6' : 'text-orange-6'}`}>
              {t(REMOTE_URL_CODE_KEYS[code])}
            </div>
          );
        })}
      </div>
    );

  const mcpConfigSnippet = useMemo(() => {
    const url = endpoints.mcpEndpoint ?? joinRemotePath(savedMcp ?? 'https://your-domain.example', '/ide/mcp');
    return JSON.stringify(
      {
        mcpServers: {
          'aionui-omni-ide': {
            transport: 'http',
            url,
            headers: { Authorization: 'Bearer <PASTE_TOKEN>' },
          },
        },
      },
      null,
      2
    );
  }, [endpoints.mcpEndpoint, savedMcp]);

  return (
    <div className='space-y-12px'>
      <Alert type='info' showIcon content={t('externalMcp.remote.setup.intro')} />

      {/* Stable MCP base URL */}
      <div className='space-y-4px'>
        <div className='text-12px text-t-primary'>{t('externalMcp.remote.setup.mcpBaseUrl')}</div>
        <Input
          value={mcpDraft}
          placeholder={t('externalMcp.remote.setup.mcpBaseUrlPlaceholder')}
          disabled={busy}
          onChange={setMcpDraft}
          onBlur={() => validateInto(mcpDraft, setMcpCodes)}
        />
        {renderFieldNotes(mcpCodes)}
      </div>

      {/* Stable WebUI base URL */}
      <div className='space-y-4px'>
        <div className='text-12px text-t-primary'>{t('externalMcp.remote.setup.webuiBaseUrl')}</div>
        <Input
          value={webuiDraft}
          placeholder={t('externalMcp.remote.setup.webuiBaseUrlPlaceholder')}
          disabled={busy}
          onChange={setWebuiDraft}
          onBlur={() => validateInto(webuiDraft, setWebuiCodes)}
        />
        {renderFieldNotes(webuiCodes)}
      </div>

      <div className='flex items-center gap-8px'>
        <Button
          type='primary'
          loading={busy}
          onClick={() => {
            void onSave(mcpDraft, webuiDraft);
          }}
        >
          {t('externalMcp.remote.setup.save')}
        </Button>
        {mcpChanged ? (
          <span className='text-12px text-orange-6'>{t('externalMcp.remote.setup.connectorUpdateWarning')}</span>
        ) : null}
      </div>

      {/* Reverse-proxy hints — provider-agnostic. */}
      <div className='bg-1 rd-8px border border-border-2 p-12px space-y-4px'>
        <div className='text-12px text-t-secondary'>
          {t('externalMcp.remote.setup.localTargetHint', { target: LOCAL_MCP_TARGET })}
        </div>
        <div className='text-12px text-t-secondary'>
          {t('externalMcp.remote.setup.localWebuiTargetHint', { target: LOCAL_WEBUI_TARGET })}
        </div>
      </div>

      {/* Generated endpoints (only when a valid MCP URL is saved). */}
      {endpoints.mcpEndpoint ? (
        <div className='space-y-12px'>
          <div className='space-y-4px'>
            <div className='text-12px text-t-primary'>{t('externalMcp.remote.setup.generatedMcp')}</div>
            <Input
              readOnly
              value={endpoints.mcpEndpoint}
              addAfter={
                <Button
                  type='text'
                  icon={<Copy size='14' />}
                  onClick={() => {
                    void onCopyValue(endpoints.mcpEndpoint ?? undefined);
                  }}
                />
              }
            />
          </div>

          {savedWebui ? (
            <div className='space-y-4px'>
              <div className='text-12px text-t-primary'>{t('externalMcp.remote.setup.generatedWebui')}</div>
              <Input
                readOnly
                value={savedWebui}
                addAfter={
                  <Button
                    type='text'
                    icon={<Copy size='14' />}
                    onClick={() => {
                      void onCopyValue(savedWebui);
                    }}
                  />
                }
              />
            </div>
          ) : null}

          <div className='space-y-4px'>
            <div className='flex items-center justify-between'>
              <div className='text-12px text-t-primary'>{t('externalMcp.remote.setup.connectorConfig')}</div>
              <Button
                icon={<Copy size='14' />}
                size='mini'
                onClick={() => {
                  void onCopyValue(mcpConfigSnippet);
                }}
              >
                {t('externalMcp.mcpJson.copy')}
              </Button>
            </div>
            <pre className='text-12px bg-1 rd-6px px-12px py-8px overflow-x-auto m-0'>
              <code>{mcpConfigSnippet}</code>
            </pre>
          </div>
        </div>
      ) : (
        <Alert type='warning' showIcon content={t('externalMcp.remote.setup.configurationNeeded')} />
      )}
    </div>
  );
};

/** Auth-mode options rendered in the selector (label keys resolved via i18n). */
const AUTH_MODE_OPTIONS: readonly OmniAuthMode[] = ['bearer', 'oauth', 'mixed', 'none'];

/** A row in the per-tool permission table. */
type ToolPermRow = { name: string; description: string; dangerous: boolean };

const ALL_TOOL_ROWS: ToolPermRow[] = [
  ...OMNI_IDE_BASE_ALLOWLIST.map((tool) => ({ name: tool.name, description: tool.description, dangerous: false })),
  ...OMNI_IDE_DANGEROUS_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, dangerous: true })),
];

/**
 * Multi-mode authentication block: auth-mode selector, idle session TTL,
 * per-tool permission table, and the registered OAuth client list with revoke.
 * Rendered inside the main panel; all writes flow through the parent handlers.
 */
const AuthSection: React.FC<{
  status: OmniGatewayStatusDto;
  busy: boolean;
  t: (key: string, opts?: Record<string, unknown>) => string;
  onSetAuthMode: (mode: OmniAuthMode) => void | Promise<void>;
  onCommitTtl: (hours: number) => void | Promise<void>;
  onSetToolPermission: (toolName: string, allowed: boolean | null) => void | Promise<void>;
  onRevokeOAuthClient: (clientId: string) => void;
  onCopyValue: (value: string | undefined) => void | Promise<void>;
}> = ({ status, busy, t, onSetAuthMode, onCommitTtl, onSetToolPermission, onRevokeOAuthClient, onCopyValue }) => {
  const auth = status.auth;
  const mode = auth?.mode ?? 'bearer';
  const ttlHours = auth ? Math.round((auth.sessionTtlMs / (60 * 60 * 1000)) * 10) / 10 : 6;
  const [ttlDraft, setTtlDraft] = useState<number>(ttlHours);

  useEffect(() => {
    setTtlDraft(ttlHours);
  }, [ttlHours]);

  const perms = auth?.toolPermissions ?? {};
  const oauthClients = auth?.oauthClients ?? [];
  const showOAuth = mode === 'oauth' || mode === 'mixed';

  /** Resolve the effective state of a tool: 'allow' | 'deny' | 'default'. */
  const effState = (row: ToolPermRow): 'allow' | 'deny' | 'default' => {
    const explicit = perms[row.name];
    if (explicit === true) return 'allow';
    if (explicit === false) return 'deny';
    return 'default';
  };

  return (
    <div className='border-t border-border-2 pt-16px space-y-16px'>
      <div className='flex items-center gap-8px'>
        <span className='text-14px text-t-primary'>{t('externalMcp.auth.title')}</span>
        <Tag color='arcoblue' size='small'>
          {t(`externalMcp.auth.mode.${mode}`)}
        </Tag>
      </div>
      <div className='text-12px text-t-secondary'>{t('externalMcp.auth.description')}</div>

      {/* Auth-mode selector */}
      <div className='space-y-8px'>
        <div className='text-12px text-t-primary'>{t('externalMcp.auth.modeLabel')}</div>
        <Radio.Group
          type='button'
          value={mode}
          disabled={busy}
          onChange={(value) => {
            void onSetAuthMode(value as OmniAuthMode);
          }}
        >
          {AUTH_MODE_OPTIONS.map((m) => (
            <Radio key={m} value={m}>
              {t(`externalMcp.auth.mode.${m}`)}
            </Radio>
          ))}
        </Radio.Group>
        <div className='text-12px text-t-secondary'>{t(`externalMcp.auth.modeHint.${mode}`)}</div>
      </div>

      {/* Session TTL */}
      <div className='space-y-4px'>
        <div className='text-12px text-t-primary flex items-center gap-4px'>
          {t('externalMcp.auth.ttlLabel')}
          <Tooltip content={t('externalMcp.auth.ttlHint')}>
            <Help theme='outline' size='12' />
          </Tooltip>
        </div>
        <div className='flex items-center gap-8px'>
          <InputNumber
            value={ttlDraft}
            min={0.1}
            max={168}
            step={0.5}
            precision={1}
            style={{ width: 140 }}
            suffix={t('externalMcp.auth.ttlUnit')}
            disabled={busy}
            onChange={(value) => {
              if (typeof value === 'number') setTtlDraft(value);
            }}
            onBlur={() => {
              void onCommitTtl(ttlDraft);
            }}
          />
        </div>
      </div>

      {/* OAuth clients (only meaningful in oauth/mixed) */}
      {showOAuth ? (
        <div className='space-y-8px'>
          <div className='flex items-center justify-between'>
            <div className='text-12px text-t-primary'>{t('externalMcp.auth.oauth.title')}</div>
            {auth?.oauthMetadataUrl ? (
              <Button
                size='mini'
                icon={<Copy size='12' />}
                onClick={() => {
                  void onCopyValue(auth.oauthMetadataUrl);
                }}
              >
                {t('externalMcp.auth.oauth.copyMetadata')}
              </Button>
            ) : null}
          </div>
          <div className='text-12px text-t-secondary'>{t('externalMcp.auth.oauth.hint')}</div>
          {oauthClients.length === 0 ? (
            <div className='text-12px text-t-secondary bg-1 rd-6px px-12px py-8px'>
              {t('externalMcp.auth.oauth.empty')}
            </div>
          ) : (
            <div className='space-y-8px'>
              {oauthClients.map((client) => (
                <div
                  key={client.clientId}
                  className='flex items-center justify-between gap-8px bg-1 rd-6px px-12px py-8px'
                >
                  <div className='min-w-0'>
                    <div className='text-12px text-t-primary truncate'>{client.clientName || client.clientId}</div>
                    <div className='text-12px text-t-secondary truncate'>
                      {t('externalMcp.auth.oauth.tokenCount', { count: client.activeTokenCount })}
                    </div>
                  </div>
                  <Button
                    size='mini'
                    status='danger'
                    disabled={busy}
                    onClick={() => onRevokeOAuthClient(client.clientId)}
                  >
                    {t('externalMcp.auth.oauth.revoke')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* Per-tool permissions */}
      <div className='space-y-8px'>
        <div className='text-12px text-t-primary'>{t('externalMcp.auth.tools.title')}</div>
        <div className='text-12px text-t-secondary'>{t('externalMcp.auth.tools.hint')}</div>
        <Table
          size='small'
          borderCell
          pagination={false}
          rowKey='name'
          data={ALL_TOOL_ROWS}
          columns={[
            {
              title: t('externalMcp.auth.tools.colTool'),
              dataIndex: 'name',
              render: (_: unknown, row: ToolPermRow) => (
                <div className='flex items-center gap-6px'>
                  <code className='text-12px'>{row.name}</code>
                  {row.dangerous ? (
                    <Tag color='red' size='small'>
                      {t('externalMcp.auth.tools.dangerous')}
                    </Tag>
                  ) : null}
                </div>
              ),
            },
            {
              title: t('externalMcp.auth.tools.colPermission'),
              dataIndex: 'name',
              width: 180,
              render: (_: unknown, row: ToolPermRow) => (
                <Select
                  size='mini'
                  value={effState(row)}
                  disabled={busy}
                  style={{ width: 150 }}
                  onChange={(value) => {
                    const next = value === 'default' ? null : value === 'allow';
                    void onSetToolPermission(row.name, next);
                  }}
                  options={[
                    { label: t('externalMcp.auth.tools.permDefault'), value: 'default' },
                    { label: t('externalMcp.auth.tools.permAllow'), value: 'allow' },
                    { label: t('externalMcp.auth.tools.permDeny'), value: 'deny' },
                  ]}
                />
              ),
            },
          ]}
        />
      </div>
    </div>
  );
};

/**
 * Inline progress strip rendered above the Web Access controls. Translates the
 * raw phase enum into an i18n string and switches the surface color so the
 * user can tell at a glance whether things are still working, succeeded, or
 * failed. The `ready` / `stopped` phases stay visible briefly so the user
 * notices the transition without having to chase a flashing element.
 */
const ProgressStrip: React.FC<{
  progress: OmniGatewayProgressEvent;
  t: (key: string, opts?: Record<string, unknown>) => string;
}> = ({ progress, t }) => {
  const tone = phaseTone(progress.phase);
  const inflight = INFLIGHT_PHASES.has(progress.phase);

  const phaseKeyMap: Record<OmniGatewayProgressPhase, string> = {
    idle: '',
    'checking-cloudflared': 'externalMcp.web.progress.checkingCloudflared',
    'installing-cloudflared': 'externalMcp.web.progress.installingCloudflared',
    'minting-token': 'externalMcp.web.progress.mintingToken',
    'spawning-tunnel': 'externalMcp.web.progress.spawningTunnel',
    'waiting-tunnel-url': 'externalMcp.web.progress.waitingTunnelUrl',
    ready: 'externalMcp.web.progress.ready',
    failed: 'externalMcp.web.progress.failed',
    stopping: 'externalMcp.web.progress.stopping',
    stopped: 'externalMcp.web.progress.stopped',
  };

  const key = phaseKeyMap[progress.phase];
  if (!key) return null;
  const text = progress.phase === 'failed' ? t(key, { error: progress.error ?? '' }) : t(key);

  const borderClass =
    tone === 'red'
      ? 'border-red-3 bg-red-1/40 text-red-7'
      : tone === 'green'
        ? 'border-green-3 bg-green-1/40 text-green-7'
        : tone === 'gray'
          ? 'border-border-2 bg-1 text-t-secondary'
          : 'border-sky-3 bg-sky-1/40 text-sky-7';

  return (
    <div
      className={`flex items-center gap-8px rd-6px border px-12px py-8px text-12px ${borderClass}`}
      role='status'
      aria-live='polite'
    >
      {inflight ? <Spin size={14} /> : null}
      <span className='flex-1'>{text}</span>
      {progress.tunnelUrl ? <span className='text-t-secondary truncate'>{progress.tunnelUrl}</span> : null}
    </div>
  );
};

export default ExternalMcpGatewaySettings;
