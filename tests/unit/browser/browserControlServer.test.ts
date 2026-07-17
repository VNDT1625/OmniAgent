import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import {
  createBrowserControlServer,
  type BrowserControlDeps,
  type QuickTestControl,
} from '@/process/resources/builtinMcp/browserControlServer';

const makeQuickTest = (): QuickTestControl => ({
  discover: vi.fn().mockResolvedValue({ targets: ['web'] }),
  start: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
  observe: vi.fn().mockResolvedValue({ observing: true }),
  status: vi.fn().mockResolvedValue({ phase: 'running' }),
  save: vi.fn().mockResolvedValue({ testId: 'test-1' }),
  replay: vi.fn().mockResolvedValue({ status: 'passed' }),
  stop: vi.fn().mockResolvedValue({ stopped: true }),
  close: vi.fn().mockResolvedValue({ closed: true }),
});

const connect = async (quickTest?: QuickTestControl, overrides: Partial<BrowserControlDeps> = {}): Promise<Client> => {
  const deps = {
    viewManager: {},
    createInput: vi.fn(),
    pagePerception: {},
    mediaPipeline: {},
    coordinator: {},
    quickTest,
    ...overrides,
  } as unknown as BrowserControlDeps;
  const server = createBrowserControlServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'browser-control-test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
};

const textOf = (result: unknown): string => {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((item) => item.text ?? '').join('\n');
};

type DelegationCase = {
  tool: string;
  method: keyof QuickTestControl;
  arguments: Record<string, unknown>;
  expected: Record<string, unknown>;
};

const delegationCases: DelegationCase[] = [
  {
    tool: 'quick_test_discover',
    method: 'discover',
    arguments: { rootPath: 'C:/repo' },
    expected: { rootPath: 'C:/repo' },
  },
  {
    tool: 'quick_test_start',
    method: 'start',
    arguments: { rootPath: 'C:/repo', mode: 'services', serviceIds: ['frontend', 'backend'], tabId: 'tab-1' },
    expected: {
      rootPath: 'C:/repo',
      mode: 'services',
      serviceIds: ['frontend', 'backend'],
      url: undefined,
      tabId: 'tab-1',
    },
  },
  {
    tool: 'quick_test_observe',
    method: 'observe',
    arguments: { sessionId: 'session-1' },
    expected: { sessionId: 'session-1' },
  },
  {
    tool: 'quick_test_status',
    method: 'status',
    arguments: { sessionId: 'session-1' },
    expected: { sessionId: 'session-1' },
  },
  {
    tool: 'quick_test_save',
    method: 'save',
    arguments: { sessionId: 'session-1', name: 'Checkout' },
    expected: { sessionId: 'session-1', name: 'Checkout' },
  },
  {
    tool: 'quick_test_replay',
    method: 'replay',
    arguments: { rootPath: 'C:/repo', testId: 'test-1' },
    expected: { rootPath: 'C:/repo', testId: 'test-1', tabId: undefined },
  },
  {
    tool: 'quick_test_stop',
    method: 'stop',
    arguments: { sessionId: 'session-1', keepTab: true },
    expected: { sessionId: 'session-1', keepTab: true },
  },
  {
    tool: 'quick_test_close',
    method: 'close',
    arguments: { sessionId: 'session-1' },
    expected: { sessionId: 'session-1' },
  },
];

describe('browserControlServer Quick Test tools', () => {
  it('keeps Quick Test tools hidden when the lifecycle is not injected', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.some((name) => name.startsWith('quick_test_'))).toBe(false);
  });

  it('exposes the complete lifecycle when injected', async () => {
    const client = await connect(makeQuickTest());
    const names = (await client.listTools()).tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith('quick_test_'));
    expect(names.toSorted()).toEqual([
      'quick_test_audit',
      'quick_test_capture',
      'quick_test_close',
      'quick_test_discover',
      'quick_test_observe',
      'quick_test_replay',
      'quick_test_save',
      'quick_test_start',
      'quick_test_status',
      'quick_test_stop',
      'quick_test_visibility',
    ]);
  });

  it.each(delegationCases)(
    'delegates $tool with a validated request',
    async ({ tool, method, arguments: args, expected }) => {
      const quickTest = makeQuickTest();
      const client = await connect(quickTest);
      await client.callTool({ name: tool, arguments: args });
      expect(quickTest[method]).toHaveBeenCalledWith(expected);
    }
  );

  it('rejects a services launch without explicit service ids', async () => {
    const quickTest = makeQuickTest();
    const client = await connect(quickTest);
    const result = await client.callTool({
      name: 'quick_test_start',
      arguments: { rootPath: 'C:/repo', mode: 'services' },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(quickTest.start).not.toHaveBeenCalled();
  });

  it('returns a severity-first bounded UI audit for the session tab', async () => {
    const quickTest = makeQuickTest();
    vi.mocked(quickTest.status).mockResolvedValueOnce({
      sessionId: 'session-1',
      rootPath: 'C:/repo',
      mode: 'frontend',
      tabId: 'tab-1',
      url: 'http://localhost:3000',
      services: [],
      running: true,
      observing: true,
      recordedEvents: 2,
      terminalSessionIds: [],
    });
    const contents = { executeJavaScript: vi.fn() };
    const findings = Array.from({ length: 45 }, (_, index) => ({
      ruleId: `rule-${index}`,
      category: 'accessibility' as const,
      severity: index === 44 ? ('critical' as const) : ('minor' as const),
      selector: `#item-${index}`,
      detail: 'Finding',
    }));
    const auditPage = vi.fn().mockResolvedValue({
      score: 73,
      auditedAt: 100,
      url: 'http://localhost:3000',
      elementCount: 120,
      findings,
      categoryScores: { contrast: 80, typography: 90, accessibility: 60, layout: 70, interaction: 65 },
    });
    const client = await connect(quickTest, {
      viewManager: { getWebContents: vi.fn().mockReturnValue(contents) } as never,
      auditPage,
    });

    const result = await client.callTool({ name: 'quick_test_audit', arguments: { sessionId: 'session-1' } });
    const payload = JSON.parse(textOf(result)) as {
      totalFindings: number;
      findings: Array<{ severity: string }>;
      truncated: boolean;
    };
    expect(auditPage).toHaveBeenCalledWith(contents);
    expect(payload.totalFindings).toBe(45);
    expect(payload.findings).toHaveLength(40);
    expect(payload.findings[0]?.severity).toBe('critical');
    expect(payload.truncated).toBe(true);
  });

  it('captures full-page evidence through the shared Quick Test capture engine', async () => {
    const quickTest = makeQuickTest();
    vi.mocked(quickTest.status).mockResolvedValueOnce({
      sessionId: 'session-1',
      rootPath: 'C:/repo',
      mode: 'frontend',
      tabId: 'tab-1',
      url: 'http://localhost:3000',
      services: [],
      running: true,
      observing: true,
      recordedEvents: 0,
      terminalSessionIds: [],
    });
    const contents = { executeJavaScript: vi.fn() };
    const captureEvidence = vi.fn().mockResolvedValue({
      filePath: 'C:/repo/.omni/inspect/shot-full-page-1.png',
      dataUrl: 'data:image/png;base64,cG5n',
      mode: 'fullPage',
    });
    const client = await connect(quickTest, {
      viewManager: { getWebContents: vi.fn().mockReturnValue(contents) } as never,
      captureEvidence,
    });

    const result = await client.callTool({
      name: 'quick_test_capture',
      arguments: { sessionId: 'session-1', mode: 'fullPage' },
    });
    const content = (result as { content: Array<{ type: string; data?: string; text?: string }> }).content;
    expect(captureEvidence).toHaveBeenCalledWith(contents, 'C:/repo', 'fullPage');
    expect(content.find((item) => item.type === 'image')?.data).toBe('cG5n');
    expect(content.find((item) => item.type === 'text')?.text).toContain('shot-full-page-1.png');
  });

  it('rejects evidence collection when the session has no browser tab', async () => {
    const quickTest = makeQuickTest();
    vi.mocked(quickTest.status).mockResolvedValueOnce({
      sessionId: 'session-1',
      rootPath: 'C:/repo',
      mode: 'services',
      url: '',
      services: [],
      running: true,
      observing: false,
      recordedEvents: 0,
      terminalSessionIds: [],
    });
    const auditPage = vi.fn();
    const client = await connect(quickTest, { auditPage });
    const result = await client.callTool({ name: 'quick_test_audit', arguments: { sessionId: 'session-1' } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('no browser tab');
    expect(auditPage).not.toHaveBeenCalled();
  });

  it('returns dependency failures as bounded MCP errors', async () => {
    const quickTest = makeQuickTest();
    vi.mocked(quickTest.status).mockRejectedValueOnce(new Error('session disappeared'));
    const client = await connect(quickTest);
    const result = await client.callTool({ name: 'quick_test_status', arguments: { sessionId: 'session-1' } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('session disappeared');
  });
});

describe('browserControlServer browser_secret_type', () => {
  it('delegates an alias-only request and returns confirmation without the secret value', async () => {
    const fillSecret = vi.fn().mockResolvedValue(undefined);
    const client = await connect(undefined, {
      fillSecret,
      getActiveTabId: () => 'active-tab',
    });

    const result = await client.callTool({
      name: 'browser_secret_type',
      arguments: { repository: 'C:/repo', selector: '#api-key', secret_alias: 'API_KEY' },
    });

    expect(fillSecret).toHaveBeenCalledWith({
      repository: 'C:/repo',
      selector: '#api-key',
      secretAlias: 'API_KEY',
      tabId: 'active-tab',
    });
    expect(textOf(result)).toContain('The secret value was not exposed.');
  });

  it('rejects a raw secret-shaped alias before it can reach a browser callback', async () => {
    const fillSecret = vi.fn().mockResolvedValue(undefined);
    const client = await connect(undefined, { fillSecret });

    const result = await client.callTool({
      name: 'browser_secret_type',
      arguments: { repository: 'C:/repo', selector: '#api-key', secret_alias: 'not a valid alias' },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(fillSecret).not.toHaveBeenCalled();
  });

  it('does not include a callback failure detail in an MCP error', async () => {
    const client = await connect(undefined, {
      fillSecret: vi.fn().mockRejectedValue(new Error('resolved value: never-expose-this')),
      getActiveTabId: () => 'active-tab',
    });

    const result = await client.callTool({
      name: 'browser_secret_type',
      arguments: { repository: 'C:/repo', selector: '#api-key', secret_alias: 'API_KEY' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).not.toContain('never-expose-this');
  });
});
