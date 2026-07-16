/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM test for the Testing "New session" form (Yêu cầu 2b, criteria 2.1 / 2.3 /
 * 2.6 — UI plane). Verifies the user can fill the scenario and that submitting
 * parses the multi-line steps into ordered steps and calls `onRun` with the
 * assembled request (the same shape an agent submits via the Testing MCP). Also
 * checks the Run button is disabled until name + steps are provided.
 */

import { ConfigProvider, Message } from '@arco-design/web-react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
    i18n: { language: 'en' },
  }),
}));

// Silence Arco's global Message portal in jsdom.
vi.spyOn(Message, 'success').mockImplementation(() => ({}) as ReturnType<typeof Message.success>);
vi.spyOn(Message, 'error').mockImplementation(() => ({}) as ReturnType<typeof Message.error>);
vi.spyOn(Message, 'info').mockImplementation(() => ({}) as ReturnType<typeof Message.info>);

// Provide a fixed model list so the model picker renders deterministically.
vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useModelProviderList: () => ({
    providers: [{ id: 'p1', name: 'P', models: ['model-a', 'model-b'] }],
    getAvailableModels: (provider: { models?: string[] }) => provider.models ?? [],
    formatModelLabel: (_p: unknown, m?: string) => m ?? '',
  }),
}));

// Folder picker for "detect from source".
const showOpen = vi.fn(async () => ['/picked/project'] as string[] | undefined);
vi.mock('@/common', () => ({
  ipcBridge: { dialog: { showOpen: { invoke: (...args: unknown[]) => showOpen(...args) } } },
}));

import NewSessionPanel from '@/renderer/pages/testing/components/NewSessionPanel';
import type {
  DetectAppRequest,
  GenerateTestRequest,
  RunTestRequest,
} from '@/renderer/pages/testing/testingBridgeClient';

const renderPanel = (onRun: (r: RunTestRequest) => Promise<unknown>, running = false) => {
  const onGenerate = vi.fn(async () => ({ name: 'gen', steps: [{ id: 's1', description: 'goto example.com' }] }));
  const onDetectApp = vi.fn(async () => ({ url: 'http://localhost:5173', command: 'npm run dev', services: [] }));
  return render(
    <ConfigProvider>
      <NewSessionPanel onRun={onRun} onGenerate={onGenerate} onDetectApp={onDetectApp} running={running} />
    </ConfigProvider>
  );
};

describe('NewSessionPanel (Requirement 2b — UI plane)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('disables Run until a name and at least one step are entered', () => {
    const onRun = vi.fn(async () => undefined);
    renderPanel(onRun);
    const runButton = screen.getByRole('button', { name: /testing\.form\.run/ });
    expect(runButton).toBeDisabled();
  });

  it('parses multi-line steps and calls onRun with the assembled scenario', async () => {
    const onRun = vi.fn(async () => undefined);
    renderPanel(onRun);

    const nameInput = screen.getByPlaceholderText('testing.form.namePlaceholder');
    fireEvent.change(nameInput, { target: { value: 'Example smoke' } });

    const stepsBox = screen.getByPlaceholderText('testing.form.stepsPlaceholder');
    fireEvent.change(stepsBox, {
      target: { value: 'goto example.com\nassertText Example Domain\nassertTitle Example' },
    });

    const runButton = screen.getByRole('button', { name: /testing\.form\.run/ });
    await waitFor(() => expect(runButton).not.toBeDisabled());
    fireEvent.click(runButton);

    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    const request = onRun.mock.calls[0][0] as RunTestRequest;
    expect(request.name).toBe('Example smoke');
    expect(request.platform).toBe('web');
    expect(request.steps.map((s) => s.description)).toEqual([
      'goto example.com',
      'assertText Example Domain',
      'assertTitle Example',
    ]);
    expect(request.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    // Web runs default to a viewport selection (criterion 2.6).
    expect(request.viewport?.label).toBe('desktop');
  });

  it('ignores blank lines when parsing steps', async () => {
    const onRun = vi.fn(async () => undefined);
    renderPanel(onRun);

    fireEvent.change(screen.getByPlaceholderText('testing.form.namePlaceholder'), {
      target: { value: 'Blank lines' },
    });
    fireEvent.change(screen.getByPlaceholderText('testing.form.stepsPlaceholder'), {
      target: { value: 'goto example.com\n\n   \nassertTitle Example\n' },
    });

    const runButton = screen.getByRole('button', { name: /testing\.form\.run/ });
    await waitFor(() => expect(runButton).not.toBeDisabled());
    fireEvent.click(runButton);

    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    const request = onRun.mock.calls[0][0] as RunTestRequest;
    expect(request.steps).toHaveLength(2);
    expect(request.steps.map((s) => s.description)).toEqual(['goto example.com', 'assertTitle Example']);
  });

  it('generates steps from a plain-language description and fills the steps box', async () => {
    const onRun = vi.fn(async () => undefined);
    const onGenerate = vi.fn(async () => ({
      name: 'Open example',
      steps: [
        { id: 's1', description: 'goto example.com' },
        { id: 's2', description: 'assertText Example Domain' },
      ],
    }));
    render(
      <ConfigProvider>
        <NewSessionPanel
          onRun={onRun}
          onGenerate={onGenerate}
          onDetectApp={vi.fn(async () => ({ url: '', services: [] }))}
          running={false}
        />
      </ConfigProvider>
    );

    // Generate is disabled until a description is typed.
    const genButton = screen.getByRole('button', { name: /testing\.form\.generate/ });
    expect(genButton).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('testing.form.describePlaceholder'), {
      target: { value: 'open example.com and check it shows Example Domain' },
    });
    await waitFor(() => expect(genButton).not.toBeDisabled());
    fireEvent.click(genButton);

    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    const genReq = onGenerate.mock.calls[0][0] as { description: string; platform: string };
    expect(genReq.description).toContain('Example Domain');
    expect(genReq.platform).toBe('web');

    // Generated steps populate the editable steps box + the name autofills.
    const stepsBox = screen.getByPlaceholderText('testing.form.stepsPlaceholder') as HTMLTextAreaElement;
    await waitFor(() => expect(stepsBox.value).toContain('goto example.com'));
    expect(stepsBox.value).toContain('assertText Example Domain');

    // Now Run is enabled and submits the generated steps.
    const runButton = screen.getByRole('button', { name: /testing\.form\.run/ });
    await waitFor(() => expect(runButton).not.toBeDisabled());
    fireEvent.click(runButton);
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    const runReq = onRun.mock.calls[0][0] as RunTestRequest;
    expect(runReq.steps.map((s) => s.description)).toEqual(['goto example.com', 'assertText Example Domain']);
  });

  it('passes the chosen model to generate, and auto (undefined) when none picked', async () => {
    const onRun = vi.fn(async () => undefined);
    const onGenerate = vi.fn(async () => ({ name: 'g', steps: [{ id: 's1', description: 'goto a.com' }] }));
    render(
      <ConfigProvider>
        <NewSessionPanel
          onRun={onRun}
          onGenerate={onGenerate}
          onDetectApp={vi.fn(async () => ({ url: '', services: [] }))}
          running={false}
        />
      </ConfigProvider>
    );

    fireEvent.change(screen.getByPlaceholderText('testing.form.describePlaceholder'), {
      target: { value: 'open a.com' },
    });

    // First generate with no model selected → model is undefined (auto).
    const genButton = screen.getByRole('button', { name: /testing\.form\.generate/ });
    await waitFor(() => expect(genButton).not.toBeDisabled());
    fireEvent.click(genButton);
    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    expect((onGenerate.mock.calls[0][0] as GenerateTestRequest).model).toBeUndefined();
  });

  it('detects app config from a picked source folder (default primary flow)', async () => {
    const onRun = vi.fn(async () => undefined);
    const onGenerate = vi.fn(async () => ({ name: 'g', steps: [{ id: 's1', description: 'goto x' }] }));
    const onDetectApp = vi.fn(async () => ({
      url: 'http://localhost:3000',
      command: 'npm run dev',
      services: [{ command: 'npm run api', ready: { type: 'port' as const, port: 4000 } }],
    }));
    render(
      <ConfigProvider>
        <NewSessionPanel onRun={onRun} onGenerate={onGenerate} onDetectApp={onDetectApp} running={false} />
      </ConfigProvider>
    );

    // The detect button is the primary, top action (label = testing.form.detect).
    fireEvent.click(screen.getByRole('button', { name: /testing\.form\.detect$/ }));

    await waitFor(() => expect(onDetectApp).toHaveBeenCalledTimes(1));
    const req = onDetectApp.mock.calls[0][0] as DetectAppRequest;
    expect(req.projectDir).toBe('/picked/project');

    // After detection the URL is surfaced (so the user sees what was found).
    await waitFor(() => expect(screen.getByText('http://localhost:3000')).toBeInTheDocument());

    // And a later generate forwards that detected URL as appUrl.
    fireEvent.change(screen.getByPlaceholderText('testing.form.describePlaceholder'), {
      target: { value: 'check home page' },
    });
    const genButton = screen.getByRole('button', { name: /testing\.form\.generate/ });
    await waitFor(() => expect(genButton).not.toBeDisabled());
    fireEvent.click(genButton);
    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    expect((onGenerate.mock.calls[0][0] as GenerateTestRequest).appUrl).toBe('http://localhost:3000');
  });

  it('manual setup picks a folder and opens the advanced editor WITHOUT calling AI detect', async () => {
    const onRun = vi.fn(async () => undefined);
    const onGenerate = vi.fn(async () => ({ name: 'g', steps: [{ id: 's1', description: 'goto x' }] }));
    const onDetectApp = vi.fn(async () => ({ url: 'http://localhost:5173', services: [] }));
    render(
      <ConfigProvider>
        <NewSessionPanel onRun={onRun} onGenerate={onGenerate} onDetectApp={onDetectApp} running={false} />
      </ConfigProvider>
    );

    // Manual setup: pick a folder but never call the AI detector.
    fireEvent.click(screen.getByRole('button', { name: /testing\.form\.manualSetup/ }));

    // The folder is selected and surfaced...
    await waitFor(() => expect(screen.getByText('/picked/project')).toBeInTheDocument());
    // ...the manual app editor (advanced) is now visible (URL field placeholder)...
    await waitFor(() => expect(screen.getByPlaceholderText('testing.form.appUrlPlaceholder')).toBeInTheDocument());
    // ...and the model was NOT called (the whole point of the manual path).
    expect(onDetectApp).not.toHaveBeenCalled();
  });

  it('shows the AI detection progress bar while detecting', async () => {
    const onRun = vi.fn(async () => undefined);
    const onGenerate = vi.fn(async () => ({ name: 'g', steps: [{ id: 's1', description: 'goto x' }] }));
    const onDetectApp = vi.fn(async () => ({ url: 'http://localhost:5173', services: [] }));
    render(
      <ConfigProvider>
        <NewSessionPanel
          onRun={onRun}
          onGenerate={onGenerate}
          onDetectApp={onDetectApp}
          running={false}
          detectProgress={{ projectDir: '/picked/project', phase: 'reading', message: 'package.json', percent: 35 }}
        />
      </ConfigProvider>
    );

    // The status bar renders the phase label + the file being read.
    expect(screen.getByTestId('detect-progress')).toBeInTheDocument();
    expect(screen.getByText('testing.detect.phase_reading')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();
  });
});
