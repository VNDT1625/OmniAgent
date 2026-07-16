/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/browser/webAgentRunner — the ReAct-style tool loop that
 * turns a chat instruction into real tab actions (Requirement 1, criteria 1.2,
 * 1.3, 1.4). Every collaborator is injected, so these tests use in-memory stubs:
 *
 * - a scripted `chat` that returns a queued sequence of model replies,
 * - a fake view manager recording navigate / getWebContents,
 * - a fake human-like input recording moveAndClick / typeText.
 *
 * They assert: the loop parses fenced-JSON actions and drives the tab, streams
 * action+observation+final events, ends on `finish`, treats prose as a final
 * answer, surfaces model errors as an `error` event, and honours cancellation.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentChat, AgentEvent, WebAgentRunnerDeps } from '@/process/browser/webAgentRunner';
import { createWebAgentRunner } from '@/process/browser/webAgentRunner';
import type { IBrowserViewManager } from '@/process/browser/browserViewManager';
import type { IHumanLikeInput, InputSink } from '@/process/browser/humanLikeInput';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** A chat that yields each queued reply in order, then repeats the last one. */
const scriptedChat = (replies: string[]): { chat: AgentChat; calls: () => number } => {
  let i = 0;
  let calls = 0;
  const chat: AgentChat = async () => {
    calls += 1;
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return reply;
  };
  return { chat, calls: () => calls };
};

/** Minimal fake WebContents satisfying the structural members the runner uses. */
const fakeContents = (text: string) => ({
  executeJavaScript: vi.fn(async (code: string) => {
    if (code.includes('querySelector')) {
      // selector-point resolution → return a fixed centre
      return { x: 10, y: 20 };
    }
    if (code.includes('scrollBy')) return true;
    return text;
  }),
  sendInputEvent: vi.fn(),
});

/** Build a fake view manager exposing only what the runner calls. */
const fakeViewManager = (contents: ReturnType<typeof fakeContents>): IBrowserViewManager => {
  const loadURL = vi.fn(async () => {});
  return {
    createTab: vi.fn(() => 'tab-1'),
    destroyTab: vi.fn(),
    setBounds: vi.fn(),
    setZoom: vi.fn(),
    loadURL,
    goBack: vi.fn(() => true),
    goForward: vi.fn(() => false),
    reload: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    listTabs: vi.fn(() => [
      {
        id: 'tab-1',
        url: 'https://example.com',
        title: 'Example',
        visible: true,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      },
    ]),
    getWebContents: vi.fn(() => contents as unknown as ReturnType<IBrowserViewManager['getWebContents']>),
    dispose: vi.fn(),
  } as unknown as IBrowserViewManager;
};

/** A human-like input spy whose moves/clicks/types are no-ops. */
const fakeInput = (): IHumanLikeInput => ({
  moveMouse: vi.fn(async () => ({ x: 0, y: 0 })),
  click: vi.fn(async () => {}),
  typeText: vi.fn(async () => {}),
  moveAndClick: vi.fn(async () => {}),
});

const baseDeps = (chat: AgentChat, readText = 'PAGE TEXT'): WebAgentRunnerDeps => {
  const contents = fakeContents(readText);
  return {
    viewManager: fakeViewManager(contents),
    readText: vi.fn(async () => readText),
    createInput: (_sink: InputSink) => fakeInput(),
    chat,
    sleep: async () => {},
  };
};

const collect = (): { sink: (e: AgentEvent) => void; events: AgentEvent[] } => {
  const events: AgentEvent[] = [];
  return { sink: (e) => events.push(e), events };
};

const fence = (obj: unknown): string => '```json\n' + JSON.stringify(obj) + '\n```';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('webAgentRunner — ReAct tool loop (Requirement 1.2/1.3/1.4)', () => {
  it('navigates then finishes, streaming action → observation → final', async () => {
    const { chat } = scriptedChat([
      fence({ tool: 'navigate', url: 'facebook.com' }),
      fence({ tool: 'finish', answer: 'Done — opened Facebook.' }),
    ]);
    const deps = baseDeps(chat);
    const runner = createWebAgentRunner(deps);
    const { sink, events } = collect();

    const result = await runner.run(
      { tabId: 'tab-1', model: 'm', instruction: 'open facebook', interactive: true },
      sink
    );

    expect(result.status).toBe('done');
    expect(result.answer).toContain('Facebook');
    expect(deps.viewManager.loadURL).toHaveBeenCalledWith('tab-1', 'https://facebook.com');

    const types = events.map((e) => e.type);
    expect(types).toEqual(['action', 'observation', 'final']);
    const action = events[0];
    expect(action.type === 'action' && action.summary).toContain('navigate');
  });

  it('reads page text and reports it as an observation', async () => {
    const { chat } = scriptedChat([fence({ tool: 'read_text' }), fence({ tool: 'finish', answer: 'summary' })]);
    const deps = baseDeps(chat, 'Hello world from the page');
    const runner = createWebAgentRunner(deps);
    const { sink, events } = collect();

    await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'read it' }, sink);

    expect(deps.readText).toHaveBeenCalledWith('tab-1', undefined);
    const obs = events.find((e) => e.type === 'observation');
    expect(obs && obs.type === 'observation' && obs.summary).toContain('Hello world');
  });

  it('treats a prose (non-JSON) reply as the final answer', async () => {
    const { chat } = scriptedChat(['I cannot find a tool to use, but here is the answer.']);
    const runner = createWebAgentRunner(baseDeps(chat));
    const { sink, events } = collect();

    const result = await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'hi' }, sink);

    expect(result.status).toBe('done');
    expect(events.at(-1)?.type).toBe('final');
  });

  it('surfaces a model error as an error event without throwing', async () => {
    const chat: AgentChat = async () => {
      throw new Error('no usable model');
    };
    const runner = createWebAgentRunner(baseDeps(chat));
    const { sink, events } = collect();

    const result = await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'go' }, sink);

    expect(result.status).toBe('error');
    const err = events.find((e) => e.type === 'error');
    expect(err && err.type === 'error' && err.message).toContain('no usable model');
  });

  it('stops the loop when cancelled before the model replies', async () => {
    let resolveChat: (value: string) => void = () => {};
    const chat: AgentChat = ({ signal }) =>
      new Promise<string>((resolve, reject) => {
        resolveChat = resolve;
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const runner = createWebAgentRunner(baseDeps(chat));
    const { sink, events } = collect();

    const promise = runner.run({ tabId: 'tab-1', model: 'm', instruction: 'go' }, sink);
    runner.cancel('tab-1');
    const result = await promise;

    expect(result.status).toBe('stopped');
    expect(events.some((e) => e.type === 'stopped')).toBe(true);
    // Silence unused-resolver lint while keeping the deferred shape explicit.
    void resolveChat;
  });

  it('captures a screenshot and feeds the image to the model on the next turn', async () => {
    const { chat } = scriptedChat([
      fence({ tool: 'screenshot' }),
      fence({ tool: 'finish', answer: 'I can see the page.' }),
    ]);
    const deps = baseDeps(chat);
    const capture = vi.fn(async () => 'data:image/png;base64,AAAA');
    deps.capture = capture;
    const runner = createWebAgentRunner(deps);
    const { sink, events } = collect();

    const result = await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'look at the page' }, sink);

    expect(result.status).toBe('done');
    expect(capture).toHaveBeenCalledWith('tab-1');
    const obs = events.find((e) => e.type === 'observation');
    expect(obs && obs.type === 'observation' && obs.ok).toBe(true);
  });

  it('reports screenshot as unavailable when no capture dep is wired', async () => {
    const { chat } = scriptedChat([fence({ tool: 'screenshot' }), fence({ tool: 'finish', answer: 'done' })]);
    const deps = baseDeps(chat);
    // no capture dep
    const runner = createWebAgentRunner(deps);
    const { sink, events } = collect();

    await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'shot' }, sink);

    const obs = events.find((e) => e.type === 'observation');
    expect(obs && obs.type === 'observation' && obs.ok).toBe(false);
    expect(obs && obs.type === 'observation' && obs.summary).toContain('not available');
  });

  it('clicks an element resolved by selector via human-like input', async () => {
    const { chat } = scriptedChat([
      fence({ tool: 'click', selector: 'button.login' }),
      fence({ tool: 'finish', answer: 'clicked' }),
    ]);
    const deps = baseDeps(chat);
    const moveAndClick = vi.fn(async () => {});
    deps.createInput = () =>
      ({
        moveMouse: vi.fn(async () => ({ x: 0, y: 0 })),
        click: vi.fn(async () => {}),
        typeText: vi.fn(async () => {}),
        moveAndClick,
      }) as unknown as IHumanLikeInput;
    const runner = createWebAgentRunner(deps);
    const { sink, events } = collect();

    const result = await runner.run(
      { tabId: 'tab-1', model: 'm', instruction: 'click login', interactive: true },
      sink
    );

    expect(result.status).toBe('done');
    expect(moveAndClick).toHaveBeenCalledTimes(1);
    const obs = events.find((e) => e.type === 'observation');
    expect(obs && obs.type === 'observation' && obs.ok).toBe(true);
  });

  it('saves a site note via the remember tool', async () => {
    const { chat } = scriptedChat([
      fence({ tool: 'remember', note: 'login button is top-right' }),
      fence({ tool: 'finish', answer: 'noted' }),
    ]);
    const deps = baseDeps(chat);
    const addSiteNote = vi.fn(async () => {});
    deps.memory = { getPersona: vi.fn(async () => ''), getSiteNotes: vi.fn(async () => []), addSiteNote };
    const runner = createWebAgentRunner(deps);
    const { sink } = collect();

    const result = await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'remember this' }, sink);

    expect(result.status).toBe('done');
    expect(addSiteNote).toHaveBeenCalledWith('example.com', 'login button is top-right');
  });

  it('injects persona + site notes into the system prompt', async () => {
    const captured: Array<{ role: string; content: unknown }> = [];
    const chat: AgentChat = async ({ messages }) => {
      captured.push(...messages);
      return fence({ tool: 'finish', answer: 'ok' });
    };
    const deps = baseDeps(chat);
    deps.memory = {
      getPersona: vi.fn(async () => 'Always answer in Vietnamese.'),
      getSiteNotes: vi.fn(async () => [{ text: 'search box is at top', at: 1 }]),
      addSiteNote: vi.fn(async () => {}),
    };
    const runner = createWebAgentRunner(deps);
    const { sink } = collect();

    await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'hi' }, sink);

    const system = captured.find((m) => m.role === 'system');
    expect(String(system?.content)).toContain('Always answer in Vietnamese.');
    expect(String(system?.content)).toContain('search box is at top');
  });

  it('extracts a video transcript and feeds it back as an observation', async () => {
    const { chat } = scriptedChat([
      fence({ tool: 'video_transcript' }),
      fence({ tool: 'finish', answer: 'summary of video' }),
    ]);
    const deps = baseDeps(chat);
    const contents = { executeJavaScript: vi.fn(async () => 'spoken words from the video'), sendInputEvent: vi.fn() };
    (deps.viewManager.getWebContents as ReturnType<typeof vi.fn>).mockReturnValue(contents);
    const runner = createWebAgentRunner(deps);
    const { sink, events } = collect();

    const result = await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'summarize this video' }, sink);

    expect(result.status).toBe('done');
    const obs = events.find((e) => e.type === 'observation');
    expect(obs && obs.type === 'observation' && obs.summary).toContain('spoken words');
  });

  it('research opens a HIDDEN background tab, reads it, and closes it (never touches the user tab)', async () => {
    const { chat } = scriptedChat([
      fence({ tool: 'research', query: 'come my way lyrics' }),
      fence({ tool: 'finish', answer: 'here are the lyrics' }),
    ]);
    const deps = baseDeps(chat, 'LYRICS: on my way...');
    const createTab = vi.fn(() => 'hidden-1');
    const destroyTab = vi.fn();
    const loadURL = vi.fn(async () => {});
    (deps.viewManager.createTab as ReturnType<typeof vi.fn>).mockImplementation(createTab);
    (deps.viewManager.destroyTab as ReturnType<typeof vi.fn>).mockImplementation(destroyTab);
    (deps.viewManager.loadURL as ReturnType<typeof vi.fn>).mockImplementation(loadURL);
    const runner = createWebAgentRunner(deps);
    const { sink, events } = collect();

    const result = await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'find the lyrics' }, sink);

    expect(result.status).toBe('done');
    // Opened a HIDDEN tab (visible:false), navigated it, then destroyed it.
    expect(createTab).toHaveBeenCalledWith({
      visible: false,
      bounds: expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }),
    });
    expect(destroyTab).toHaveBeenCalledWith('hidden-1');
    // The user's tab id was never navigated.
    expect(loadURL).not.toHaveBeenCalledWith('tab-1', expect.anything());
    const obs = events.find((e) => e.type === 'observation');
    expect(obs && obs.type === 'observation' && obs.summary).toContain('LYRICS');
  });

  it('analyze_audio reports a frequency profile from the page', async () => {
    const { chat } = scriptedChat([
      fence({ tool: 'analyze_audio' }),
      fence({ tool: 'finish', answer: 'it sounds bright' }),
    ]);
    const deps = baseDeps(chat);
    const contents = {
      executeJavaScript: vi.fn(async () => 'Audio frequency profile: bass 10%, ... bright / treble-heavy.'),
      sendInputEvent: vi.fn(),
    };
    (deps.viewManager.getWebContents as ReturnType<typeof vi.fn>).mockReturnValue(contents);
    const runner = createWebAgentRunner(deps);
    const { sink, events } = collect();

    const result = await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'how does it sound' }, sink);

    expect(result.status).toBe('done');
    const obs = events.find((e) => e.type === 'observation');
    expect(obs && obs.type === 'observation' && obs.summary).toContain('frequency profile');
  });

  it('injects the current tab URL/title into the prompt so the model is never blind', async () => {
    const captured: Array<{ role: string; content: unknown }> = [];
    const chat: AgentChat = async ({ messages }) => {
      captured.push(...messages);
      return fence({ tool: 'finish', answer: 'ok' });
    };
    const deps = baseDeps(chat);
    // listTabs() in the fake reports https://example.com / "Example".
    const runner = createWebAgentRunner(deps);
    const { sink } = collect();

    await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'summarize this video' }, sink);

    const grounding = captured.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('the tab is currently on')
    );
    expect(grounding).toBeDefined();
    expect(String(grounding?.content)).toContain('https://example.com');
    expect(String(grounding?.content)).toContain('Example');
  });

  it('video_transcript falls back to a HIDDEN tab when passive extraction finds nothing', async () => {
    const { chat } = scriptedChat([fence({ tool: 'video_transcript' }), fence({ tool: 'finish', answer: 'summary' })]);
    const deps = baseDeps(chat);
    // Visible tab: passive script returns the no-captions sentinel.
    const visibleContents = { executeJavaScript: vi.fn(async () => '__NOCAP__:no source'), sendInputEvent: vi.fn() };
    // Hidden tab: active script (clicks Show transcript) yields the panel text.
    const hiddenContents = {
      executeJavaScript: vi.fn(async () => '[panel] spoken words from the transcript panel'),
      sendInputEvent: vi.fn(),
    };
    (deps.viewManager.getWebContents as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === 'hidden-1' ? hiddenContents : visibleContents
    );
    const createTab = vi.fn(() => 'hidden-1');
    const destroyTab = vi.fn();
    (deps.viewManager.createTab as ReturnType<typeof vi.fn>).mockImplementation(createTab);
    (deps.viewManager.destroyTab as ReturnType<typeof vi.fn>).mockImplementation(destroyTab);
    const runner = createWebAgentRunner(deps);
    const { sink, events } = collect();

    const result = await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'summarize this video' }, sink);

    expect(result.status).toBe('done');
    // The active path ran in a HIDDEN tab that was then destroyed.
    expect(createTab).toHaveBeenCalledWith({
      visible: false,
      bounds: expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }),
    });
    expect(destroyTab).toHaveBeenCalledWith('hidden-1');
    const obs = events.find((e) => e.type === 'observation');
    expect(obs && obs.type === 'observation' && obs.ok).toBe(true);
    expect(obs && obs.type === 'observation' && obs.summary).toContain('transcript panel');
  });

  it('video_transcript uses passive captions WITHOUT opening a hidden tab when they exist', async () => {
    const { chat } = scriptedChat([fence({ tool: 'video_transcript' }), fence({ tool: 'finish', answer: 'summary' })]);
    const deps = baseDeps(chat);
    const visibleContents = {
      executeJavaScript: vi.fn(async () => '[innertube] the real spoken transcript of the video'),
      sendInputEvent: vi.fn(),
    };
    (deps.viewManager.getWebContents as ReturnType<typeof vi.fn>).mockReturnValue(visibleContents);
    const createTab = vi.fn(() => 'hidden-1');
    (deps.viewManager.createTab as ReturnType<typeof vi.fn>).mockImplementation(createTab);
    const runner = createWebAgentRunner(deps);
    const { sink, events } = collect();

    const result = await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'summarize this video' }, sink);

    expect(result.status).toBe('done');
    // Passive extraction succeeded → no hidden tab was created (no churn on the page).
    expect(createTab).not.toHaveBeenCalled();
    const obs = events.find((e) => e.type === 'observation');
    expect(obs && obs.type === 'observation' && obs.summary).toContain('spoken transcript');
  });

  it('summarize extracts main content and runs the injected summarizer', async () => {
    const { chat } = scriptedChat([fence({ tool: 'summarize' }), fence({ tool: 'finish', answer: 'done' })]);
    const deps = baseDeps(chat);
    const readMainContent = vi.fn(async () => ({ title: 'Big Article', text: 'a'.repeat(20000) }));
    const summarize = vi.fn(async () => ({ summary: 'TL;DR: it is about X.\n- point one', chunks: 3 }));
    deps.readMainContent = readMainContent;
    deps.summarizer = { summarize };
    const runner = createWebAgentRunner(deps);
    const { sink, events } = collect();

    const result = await runner.run(
      { tabId: 'tab-1', model: 'm', instruction: 'process the page content for me' },
      sink
    );

    expect(result.status).toBe('done');
    expect(readMainContent).toHaveBeenCalledWith('tab-1');
    expect(summarize).toHaveBeenCalledTimes(1);
    const obs = events.find((e) => e.type === 'observation');
    expect(obs && obs.type === 'observation' && obs.ok).toBe(true);
    expect(obs && obs.type === 'observation' && obs.summary).toContain('Big Article');
  });

  it('summarize reports unavailable when no summarizer is wired', async () => {
    const { chat } = scriptedChat([fence({ tool: 'summarize' }), fence({ tool: 'finish', answer: 'done' })]);
    const deps = baseDeps(chat);
    const runner = createWebAgentRunner(deps);
    const { sink, events } = collect();

    await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'summarize' }, sink);

    const obs = events.find((e) => e.type === 'observation');
    expect(obs && obs.type === 'observation' && obs.ok).toBe(false);
    expect(obs && obs.type === 'observation' && obs.summary).toContain('not available');
  });

  it('deep_research runs the injected orchestrator and appends numbered sources', async () => {
    const { chat } = scriptedChat([
      fence({ tool: 'deep_research', query: 'compare A vs B' }),
      fence({ tool: 'finish', answer: 'done' }),
    ]);
    const deps = baseDeps(chat);
    const research = vi.fn(async () => ({
      answer: 'A is faster than B [1], but B is cheaper [2].',
      sources: [
        { index: 1, title: 'A docs', url: 'https://a.com' },
        { index: 2, title: 'B docs', url: 'https://b.com' },
      ],
      subQueries: ['A speed', 'B price'],
    }));
    deps.deepResearch = { research };
    const runner = createWebAgentRunner(deps);
    const { sink, events } = collect();

    const result = await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'compare them' }, sink);

    expect(result.status).toBe('done');
    expect(research).toHaveBeenCalledTimes(1);
    const obs = events.find((e) => e.type === 'observation');
    expect(obs && obs.type === 'observation' && obs.ok).toBe(true);
    expect(obs && obs.type === 'observation' && obs.summary).toContain('[1]');
  });

  it('refuses interactive tools by default (invisible mode) and tells the model to read instead', async () => {
    const { chat } = scriptedChat([
      fence({ tool: 'click', selector: 'button.buy' }),
      fence({ tool: 'finish', answer: 'I could not click.' }),
    ]);
    const deps = baseDeps(chat);
    const moveAndClick = vi.fn(async () => {});
    deps.createInput = () =>
      ({
        moveMouse: vi.fn(async () => ({ x: 0, y: 0 })),
        click: vi.fn(async () => {}),
        typeText: vi.fn(async () => {}),
        moveAndClick,
      }) as unknown as IHumanLikeInput;
    const runner = createWebAgentRunner(deps);
    const { sink, events } = collect();

    // No `interactive` flag → invisible mode.
    const result = await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'buy it' }, sink);

    expect(result.status).toBe('done');
    // The click was refused: human-like input was never driven.
    expect(moveAndClick).not.toHaveBeenCalled();
    const obs = events.find((e) => e.type === 'observation');
    expect(obs && obs.type === 'observation' && obs.ok).toBe(false);
    expect(obs && obs.type === 'observation' && obs.summary).toContain('Permission required');
  });

  it('allows interactive tools when control is granted (interactive: true)', async () => {
    const { chat } = scriptedChat([
      fence({ tool: 'scroll', direction: 'down', amount: 400 }),
      fence({ tool: 'finish', answer: 'scrolled' }),
    ]);
    const deps = baseDeps(chat);
    const runner = createWebAgentRunner(deps);
    const { sink, events } = collect();

    const result = await runner.run(
      { tabId: 'tab-1', model: 'm', instruction: 'scroll down', interactive: true },
      sink
    );

    expect(result.status).toBe('done');
    const obs = events.find((e) => e.type === 'observation');
    expect(obs && obs.type === 'observation' && obs.ok).toBe(true);
    expect(obs && obs.type === 'observation' && obs.summary).toContain('Scrolled');
  });

  it('video_transcript prefers the server-side fetcher (no tab, no in-page script)', async () => {
    const { chat } = scriptedChat([fence({ tool: 'video_transcript' }), fence({ tool: 'finish', answer: 'summary' })]);
    const deps = baseDeps(chat);
    (deps.viewManager.listTabs as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: 'tab-1',
        url: 'https://www.youtube.com/watch?v=abcdEFGH123',
        title: 'Talk',
        visible: true,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      },
    ]);
    const fetchTranscript = vi.fn(async () => ({ ok: true, text: 'server-side transcript text', lang: 'en' }));
    deps.fetchTranscript = fetchTranscript;
    const contents = {
      executeJavaScript: vi.fn(async () => '__NOCAP__:should not be called'),
      sendInputEvent: vi.fn(),
    };
    (deps.viewManager.getWebContents as ReturnType<typeof vi.fn>).mockReturnValue(contents);
    const createTab = vi.fn(() => 'hidden-1');
    (deps.viewManager.createTab as ReturnType<typeof vi.fn>).mockImplementation(createTab);
    const runner = createWebAgentRunner(deps);
    const { sink, events } = collect();

    const result = await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'summarize this video' }, sink);

    expect(result.status).toBe('done');
    expect(fetchTranscript).toHaveBeenCalledWith('https://www.youtube.com/watch?v=abcdEFGH123');
    // Server-side path won → no in-page script, no hidden tab.
    expect(contents.executeJavaScript).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
    const obs = events.find((e) => e.type === 'observation');
    expect(obs && obs.type === 'observation' && obs.summary).toContain('server-side transcript');
  });

  it('takes the one-shot fast path for "summarize this video" — single model call, no ReAct loop', async () => {
    // The chat stub would return a tool call if consulted; the fast path must NOT
    // consult it for tool selection — it calls the summarizer directly.
    const chat = vi.fn(async () => fence({ tool: 'finish', answer: 'should not be reached' })) as unknown as AgentChat;
    const deps = baseDeps(chat);
    (deps.viewManager.listTabs as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: 'tab-1',
        url: 'https://www.youtube.com/watch?v=abcdEFGH123',
        title: 'Great Talk',
        visible: true,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      },
    ]);
    // Server-side transcript fetcher returns captions directly.
    deps.fetchTranscript = vi.fn(async () => ({ ok: true, text: 'the full spoken transcript here', lang: 'en' }));
    const summarize = vi.fn(async () => ({ summary: 'TL;DR: a talk.\n- point', chunks: 1 }));
    deps.summarizer = { summarize };
    const runner = createWebAgentRunner(deps);
    const { sink, events } = collect();

    const result = await runner.run({ tabId: 'tab-1', model: 'm', instruction: 'tóm tắt video này' }, sink);

    expect(result.status).toBe('done');
    expect(result.steps).toBe(1);
    expect(summarize).toHaveBeenCalledTimes(1);
    // The model was never asked to pick a tool (no ReAct round-trip).
    expect(chat).not.toHaveBeenCalled();
    const final = events.find((e) => e.type === 'final');
    expect(final && final.type === 'final' && final.text).toContain('Great Talk');
    expect(final && final.type === 'final' && final.text).toContain('TL;DR');
  });
});
