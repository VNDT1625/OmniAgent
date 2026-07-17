/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `NewSessionPanel` — the form that lets the USER create a multi-platform test
 * session (Yêu cầu 2b, criteria 2.1 / 2.3 / 2.6).
 *
 * The PRIMARY flow is plain language: the user types what they want to test
 * ("open example.com and check it shows 'Example Domain'") and clicks "Generate
 * steps"; the user's configured model turns it into concrete steps (the user
 * never has to learn the `goto`/`assertText` grammar). The generated steps are
 * shown in an editable box so they can tweak them, then "Run test" executes.
 *
 * For web, the app-under-test (how to boot the dev server + any backend/services)
 * is declared via {@link AppUnderTestEditor} — including a "detect from source"
 * action that reads the project folder and proposes the whole setup.
 *
 * The same scenario shape an agent submits via the Testing MCP — both planes
 * drive the one shared orchestrator.
 *
 * Arco + @icon-park/react + UnoCSS semantic tokens only — no raw interactive
 * HTML, no hardcoded colors.
 */

import { ipcBridge } from '@/common';
import { Button, Input, Message, Select, Switch, Tag } from '@arco-design/web-react';
import { FolderOpen, MagicWand, Play, SettingTwo } from '@icon-park/react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useModelProviderList } from '@/renderer/hooks/agent/useModelProviderList';
import AppUnderTestEditor from './AppUnderTestEditor';
import DetectProgressBar from './DetectProgressBar';
import GenerateProgressBar from './GenerateProgressBar';
import type {
  AppUnderTest,
  DetectAppRequest,
  DetectProgress,
  GenerateProgress,
  GenerateTestRequest,
  RunTestRequest,
  TestingPlatform,
  TestingViewport,
} from '../testingBridgeClient';

/** Props for {@link NewSessionPanel}. */
export type NewSessionPanelProps = {
  /** Submit the scenario. Resolves when the run finishes. */
  onRun: (request: RunTestRequest) => Promise<unknown>;
  /** Generate an editable scenario draft from a description. */
  onGenerate: (request: GenerateTestRequest) => Promise<{ name: string; steps: { id: string; description: string }[] }>;
  /** Read a project folder and propose how to run it (services + app + url). */
  onDetectApp: (request: DetectAppRequest) => Promise<AppUnderTest>;
  /** Whether a run is currently in flight (disables the form). */
  running: boolean;
  /** Live AI-detection progress to surface as a status bar (undefined = idle). */
  detectProgress?: DetectProgress;
  /** Live AI scenario-generation progress to surface as a status bar (undefined = idle). */
  generateProgress?: GenerateProgress;
};

/** Responsive viewport presets offered for web (criterion 2.6). */
const WEB_VIEWPORTS: TestingViewport[] = [
  { width: 375, height: 667, label: 'phone' },
  { width: 768, height: 1024, label: 'tablet' },
  { width: 1280, height: 800, label: 'desktop' },
  { width: 1920, height: 1080, label: 'wide' },
];

/** Parse the multi-line steps box into ordered steps (one directive per line). */
const parseSteps = (raw: string): { id: string; description: string }[] =>
  raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((description, index) => ({ id: `s${index + 1}`, description }));

/** Whether an app-under-test declaration carries anything worth sending. */
const hasAppConfig = (app: AppUnderTest): boolean =>
  (app.url ?? '').trim().length > 0 ||
  (app.command ?? '').trim().length > 0 ||
  (app.services ?? []).length > 0 ||
  (app.exePath ?? '').trim().length > 0 ||
  (app.apkPath ?? '').trim().length > 0 ||
  (app.appPackage ?? '').trim().length > 0;

/**
 * The new-session form: a plain-language prompt that generates steps, an
 * editable step list, platform/viewport/visibility, app-under-test, and Run.
 */
const NewSessionPanel: React.FC<NewSessionPanelProps> = ({
  onRun,
  onGenerate,
  onDetectApp,
  running,
  detectProgress,
  generateProgress,
}) => {
  const { t } = useTranslation();
  const { providers, getAvailableModels } = useModelProviderList();
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<TestingPlatform>('web');
  const [viewportLabel, setViewportLabel] = useState<string>('desktop');
  const [visible, setVisible] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [stepsText, setStepsText] = useState('');
  const [generating, setGenerating] = useState(false);
  // Model used for AI features (generate steps + detect-from-source). Empty =
  // let the backend auto-pick. Some routed models reject direct chat, so letting
  // the user choose avoids "could not generate" on the wrong default.
  const [model, setModel] = useState<string>('');

  // Flat list of every enabled model across providers, for the AI-model picker.
  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const provider of providers) {
      for (const m of getAvailableModels(provider)) {
        if (!seen.has(m)) {
          seen.add(m);
          out.push(m);
        }
      }
    }
    return out;
  }, [providers, getAvailableModels]);

  // App-under-test (web): how to start the app + prerequisite services. Owned
  // here as one object so the detector can replace it wholesale.
  const [app, setApp] = useState<AppUnderTest>({ url: '', command: '', cwd: '', services: [] });
  // Windows: the .exe under test. Android: an optional APK + the app package id.
  const [exePath, setExePath] = useState<string>('');
  const [apkPath, setApkPath] = useState<string>('');
  const [appPackage, setAppPackage] = useState<string>('');
  // The project folder the user picked for "detect from source" (remembered so
  // they don't reselect). Empty until they pick one.
  const [projectDir, setProjectDir] = useState<string>('');
  const [detecting, setDetecting] = useState(false);
  // Show the manual app/services editor (advanced). Hidden by default — the
  // primary path is "detect from source".
  const [showAdvanced, setShowAdvanced] = useState(false);

  const steps = useMemo(() => parseSteps(stepsText), [stepsText]);
  const canGenerate = prompt.trim().length > 0 && !generating && !running;
  const canRun = name.trim().length > 0 && steps.length > 0 && !running && !generating;

  /** Open a folder picker; resolve the chosen directory or undefined. */
  const pickFolder = async (): Promise<string | undefined> => {
    const dirs = await ipcBridge.dialog.showOpen
      .invoke({ properties: ['openDirectory'] })
      .catch((): undefined => undefined);
    return dirs && dirs[0] ? dirs[0] : undefined;
  };

  /** Open a file picker filtered to `.exe`; resolve the chosen path or undefined. */
  const pickExe = async (): Promise<string | undefined> => {
    const files = await ipcBridge.dialog.showOpen
      .invoke({ properties: ['openFile'], filters: [{ name: 'Executable', extensions: ['exe'] }] })
      .catch((): undefined => undefined);
    return files && files[0] ? files[0] : undefined;
  };

  /** Open a file picker filtered to `.apk`; resolve the chosen path or undefined. */
  const pickApk = async (): Promise<string | undefined> => {
    const files = await ipcBridge.dialog.showOpen
      .invoke({ properties: ['openFile'], filters: [{ name: 'Android package', extensions: ['apk'] }] })
      .catch((): undefined => undefined);
    return files && files[0] ? files[0] : undefined;
  };

  /** Pick a project folder and auto-detect how to run it (the primary flow). */
  const detectFromSource = (): void => {
    if (detecting || running || generating) return;
    // If a project was already detected, picking again means "re-detect" → force
    // a fresh model run (bypass the cached <name>-data.json).
    const forceRefresh = projectDir.length > 0;
    void pickFolder().then((dir) => {
      if (!dir) return;
      setProjectDir(dir);
      setDetecting(true);
      onDetectApp({ projectDir: dir, model: model || undefined, refresh: forceRefresh && dir === projectDir })
        .then((proposed) => {
          setApp({
            url: proposed.url ?? '',
            command: proposed.command ?? '',
            cwd: proposed.cwd ?? '',
            services: proposed.services ?? [],
          });
          Message.success(t('testing.form.detected'));
        })
        .catch((error: unknown) =>
          Message.error(error instanceof Error ? error.message : t('testing.form.detectFailed'))
        )
        .finally(() => setDetecting(false));
    });
  };

  /**
   * Manual path (no AI): pick the project folder, then fill the app config by
   * hand. Pre-seeds `cwd` with the chosen folder and opens the advanced editor
   * so the user can type the URL/command/services themselves — useful when no
   * model is configured or the AI guess is wrong.
   */
  const setupManually = (): void => {
    if (detecting || running || generating) return;
    void pickFolder().then((dir) => {
      if (!dir) return;
      setProjectDir(dir);
      // Seed cwd with the folder; leave url/command for the user to fill in.
      setApp((prev) => ({ ...prev, cwd: prev.cwd?.trim() ? prev.cwd : dir }));
      setShowAdvanced(true);
      Message.info(t('testing.form.manualReady'));
    });
  };

  /** Build the optional app-under-test declaration, per platform. */
  const buildApp = (): AppUnderTest | undefined => {
    if (platform === 'web') {
      if (!hasAppConfig(app)) return undefined;
      return {
        url: (app.url ?? '').trim(),
        command: (app.command ?? '').trim() || undefined,
        cwd: (app.cwd ?? '').trim() || undefined,
        services: (app.services ?? []).filter((s) => s.command.trim().length > 0),
      };
    }
    if (platform === 'windows') {
      if (exePath.trim().length === 0) return undefined;
      return { exePath: exePath.trim() };
    }
    if (platform === 'android') {
      if (apkPath.trim().length === 0 && appPackage.trim().length === 0) return undefined;
      return {
        apkPath: apkPath.trim() || undefined,
        appPackage: appPackage.trim() || undefined,
      };
    }
    return undefined;
  };

  const generate = (): void => {
    if (!canGenerate) return;
    setGenerating(true);
    const appUrl = platform === 'web' ? (app.url ?? '').trim() || undefined : undefined;
    void onGenerate({
      description: prompt.trim(),
      platform,
      model: model || undefined,
      appUrl,
      workspace: projectDir || undefined,
    })
      .then((draft) => {
        if (!name.trim()) setName(draft.name);
        setStepsText(draft.steps.map((s) => s.description).join('\n'));
        Message.success(t('testing.form.generated'));
      })
      .catch((error: unknown) =>
        Message.error(error instanceof Error ? error.message : t('testing.form.generateFailed'))
      )
      .finally(() => setGenerating(false));
  };

  const submit = (): void => {
    if (!canRun) return;
    const viewport = platform === 'web' ? WEB_VIEWPORTS.find((v) => v.label === viewportLabel) : undefined;
    void onRun({ name: name.trim(), platform, steps, visible, viewport, app: buildApp() })
      .then(() => Message.success(t('testing.form.started')))
      .catch((error: unknown) => Message.error(error instanceof Error ? error.message : t('testing.form.failed')));
  };

  return (
    <div className='flex flex-col gap-14px'>
      {/* SOURCE (web): pick the project folder — AI works out how to run it, or
          set it up by hand. Full-width primary action + a quiet manual link so
          the header never gets cramped. */}
      {platform === 'web' ? (
        <div className='flex flex-col gap-8px'>
          <div className='flex items-center justify-between'>
            <span className='text-11px font-600 uppercase tracking-wide text-t-tertiary'>
              {t('testing.form.sourceSection')}
            </span>
            <Button
              type='text'
              size='mini'
              disabled={running || generating || detecting}
              icon={<SettingTwo theme='outline' size='13' />}
              onClick={setupManually}
            >
              {t('testing.form.manualSetup')}
            </Button>
          </div>

          {projectDir ? (
            <div className='flex flex-col gap-8px rd-8px border border-border-base bg-fill-1 p-10px'>
              <div className='flex items-center gap-8px'>
                <FolderOpen theme='outline' size='15' className='shrink-0 text-primary' />
                <span className='flex-1 text-12px text-t-primary font-mono truncate'>{projectDir}</span>
                <Button
                  type='text'
                  size='mini'
                  loading={detecting}
                  disabled={running || generating}
                  onClick={detectFromSource}
                >
                  {t('testing.form.detectAgain')}
                </Button>
              </div>
              {(app.url?.trim() || app.command?.trim() || (app.services ?? []).length > 0) && !detecting ? (
                <div className='flex flex-wrap items-center gap-4px'>
                  {app.url?.trim() ? (
                    <Tag size='small' color='arcoblue'>
                      {app.url.trim()}
                    </Tag>
                  ) : null}
                  {app.command?.trim() ? <Tag size='small'>{app.command.trim()}</Tag> : null}
                  {(app.services ?? []).length > 0 ? (
                    <Tag size='small' color='green'>
                      {t('testing.form.servicesCount', { count: (app.services ?? []).length })}
                    </Tag>
                  ) : null}
                </div>
              ) : null}
              {detecting || detectProgress ? <DetectProgressBar progress={detectProgress} /> : null}
            </div>
          ) : (
            <>
              <Button
                long
                type='primary'
                loading={detecting}
                disabled={running || generating}
                icon={<FolderOpen theme='outline' size='15' />}
                onClick={detectFromSource}
              >
                {t('testing.form.detect')}
              </Button>
              <span className='text-11px text-t-tertiary leading-snug'>{t('testing.form.sourceHint')}</span>
              {detecting || detectProgress ? <DetectProgressBar progress={detectProgress} /> : null}
            </>
          )}
        </div>
      ) : null}

      {/* DESCRIBE → generate steps with AI. */}
      <div className='flex flex-col gap-6px'>
        <span className='text-11px font-600 uppercase tracking-wide text-t-tertiary'>{t('testing.form.describe')}</span>
        <Input.TextArea
          value={prompt}
          onChange={setPrompt}
          placeholder={t('testing.form.describePlaceholder')}
          autoSize={{ minRows: 2, maxRows: 5 }}
          disabled={running || generating}
        />
        <div className='flex items-center gap-6px'>
          <Select
            value={model || undefined}
            onChange={(v) => setModel(v ?? '')}
            placeholder={t('testing.form.modelAuto')}
            allowClear
            showSearch
            size='small'
            className='flex-1'
            disabled={running || generating}
            triggerProps={{ autoAlignPopupWidth: false }}
          >
            {modelOptions.map((m) => (
              <Select.Option key={m} value={m}>
                {m}
              </Select.Option>
            ))}
          </Select>
          <Button
            type='outline'
            size='small'
            loading={generating}
            disabled={!canGenerate}
            icon={<MagicWand theme='outline' size='14' />}
            onClick={generate}
          >
            {t('testing.form.generate')}
          </Button>
        </div>
        {platform === 'web' && (app.url ?? '').trim().length === 0 && !projectDir ? (
          <span className='text-11px text-warning leading-snug'>{t('testing.form.noUrlHint')}</span>
        ) : null}
        {generating || generateProgress ? <GenerateProgressBar progress={generateProgress} /> : null}
      </div>

      <div className='flex items-center gap-8px'>
        <div className='flex flex-col gap-4px flex-1'>
          <span className='text-11px font-600 uppercase tracking-wide text-t-tertiary'>
            {t('testing.form.platform')}
          </span>
          <Select value={platform} onChange={(v) => setPlatform(v as TestingPlatform)} disabled={running || generating}>
            <Select.Option value='web'>{t('testing.form.platformWeb')}</Select.Option>
            <Select.Option value='android'>{t('testing.form.platformAndroid')}</Select.Option>
            <Select.Option value='windows'>{t('testing.form.platformWindows')}</Select.Option>
          </Select>
        </div>
        {platform === 'web' ? (
          <div className='flex flex-col gap-4px flex-1'>
            <span className='text-11px font-600 uppercase tracking-wide text-t-tertiary'>
              {t('testing.form.viewport')}
            </span>
            <Select value={viewportLabel} onChange={setViewportLabel} disabled={running || generating}>
              {WEB_VIEWPORTS.map((v) => (
                <Select.Option key={v.label} value={v.label as string}>
                  {v.label} ({v.width}×{v.height})
                </Select.Option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>

      {/* Windows: pick the .exe under test (launched on an isolated display). */}
      {platform === 'windows' ? (
        <div className='flex flex-col gap-4px'>
          <span className='text-11px font-600 uppercase tracking-wide text-t-tertiary'>
            {t('testing.form.exePath')}
          </span>
          <div className='flex items-center gap-6px'>
            <Input
              value={exePath}
              onChange={setExePath}
              placeholder={t('testing.form.exePathPlaceholder')}
              disabled={running || generating}
              className='flex-1'
            />
            <Button
              size='default'
              icon={<FolderOpen theme='outline' size='14' />}
              disabled={running || generating}
              onClick={() => void pickExe().then((p) => p && setExePath(p))}
            >
              {t('testing.form.browse')}
            </Button>
          </div>
          <span className='text-11px text-t-tertiary leading-snug'>{t('testing.form.exePathHint')}</span>
        </div>
      ) : null}

      {/* Android: an optional APK to install + the app package id to launch. */}
      {platform === 'android' ? (
        <div className='flex flex-col gap-6px'>
          <div className='flex flex-col gap-4px'>
            <span className='text-11px font-600 uppercase tracking-wide text-t-tertiary'>
              {t('testing.form.apkPath')}
            </span>
            <div className='flex items-center gap-6px'>
              <Input
                value={apkPath}
                onChange={setApkPath}
                placeholder={t('testing.form.apkPathPlaceholder')}
                disabled={running || generating}
                className='flex-1'
              />
              <Button
                size='default'
                icon={<FolderOpen theme='outline' size='14' />}
                disabled={running || generating}
                onClick={() => void pickApk().then((p) => p && setApkPath(p))}
              >
                {t('testing.form.browse')}
              </Button>
            </div>
          </div>
          <div className='flex flex-col gap-4px'>
            <span className='text-11px font-600 uppercase tracking-wide text-t-tertiary'>
              {t('testing.form.appPackage')}
            </span>
            <Input
              value={appPackage}
              onChange={setAppPackage}
              placeholder={t('testing.form.appPackagePlaceholder')}
              disabled={running || generating}
            />
          </div>
        </div>
      ) : null}

      {/* Advanced (web): manually edit / fine-tune the detected app + services. */}
      {platform === 'web' ? (
        <div className='flex flex-col gap-4px'>
          <Button
            type='text'
            size='mini'
            className='self-start'
            disabled={running || generating}
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? t('testing.form.hideAdvanced') : t('testing.form.showAdvanced')}
          </Button>
          {showAdvanced ? (
            <AppUnderTestEditor
              value={app}
              onChange={setApp}
              onDetect={onDetectApp}
              model={model || undefined}
              disabled={running || generating}
            />
          ) : null}
        </div>
      ) : null}

      <div className='flex flex-col gap-4px'>
        <span className='text-11px font-600 uppercase tracking-wide text-t-tertiary'>{t('testing.form.name')}</span>
        <Input value={name} onChange={setName} placeholder={t('testing.form.namePlaceholder')} disabled={running} />
      </div>

      {/* Generated/editable steps. Filled by "Generate steps"; advanced users can edit. */}
      <div className='flex flex-col gap-4px'>
        <span className='text-11px font-600 uppercase tracking-wide text-t-tertiary'>{t('testing.form.steps')}</span>
        <Input.TextArea
          value={stepsText}
          onChange={setStepsText}
          placeholder={t('testing.form.stepsPlaceholder')}
          autoSize={{ minRows: 4, maxRows: 10 }}
          disabled={running}
        />
      </div>

      <div className='flex items-center justify-between border-t border-border-base pt-12px'>
        <div className='flex items-center gap-8px'>
          <Switch checked={visible} onChange={setVisible} disabled={running} size='small' />
          <span className='text-12px text-t-secondary'>{t('testing.form.visible')}</span>
        </div>
        <Button
          type='primary'
          loading={running}
          disabled={!canRun}
          icon={<Play theme='outline' size='14' />}
          onClick={submit}
        >
          {t('testing.form.run')}
        </Button>
      </div>
    </div>
  );
};

export default NewSessionPanel;
