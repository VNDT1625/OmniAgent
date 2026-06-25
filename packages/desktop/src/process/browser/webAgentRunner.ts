/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Web-agent runner — the brain that turns a free-text instruction in the
 * Browser chat panel ("đưa tôi tới Facebook, đọc tin nhắn rồi tóm tắt") into a
 * sequence of real actions on the embedded tab (Requirement 1, criteria 1.2,
 * 1.3, 1.4).
 *
 * It implements a small **ReAct-style tool loop**:
 *
 *   1. Send the conversation + a tool catalog to the user's configured model
 *      (OpenAI-compatible `/chat/completions`, same call style as
 *      `companyGenerator.ts` — provider read from aioncore `GET /api/providers`).
 *   2. The model replies with EITHER a tool call (navigate / read / click /
 *      type / scroll / screenshot / finish) OR a final answer.
 *   3. The runner executes the tool against the live tab (navigation via the
 *      view manager, input via human-like input — criterion 1.3, perception via
 *      pagePerception — criterion 1.4), appends the observation, and loops.
 *   4. When the model calls `finish` (or hits the step budget) the loop ends and
 *      the final text is returned.
 *
 * Every step is streamed out through the injected {@link AgentEventSink} so the
 * renderer chat panel can show the running narration ("↳ navigate(...)",
 * "↳ click(...)") and the final answer live.
 *
 * ## Why a JSON tool protocol instead of native function-calling
 *
 * Providers differ in their function-calling wire format; some compatible
 * endpoints don't support it at all. To stay provider-agnostic (the same
 * pragmatic reason `companyGenerator` calls `/chat/completions` directly) the
 * runner asks the model to answer with a single fenced JSON object describing
 * the next action, and parses that. This works on any OpenAI-compatible model.
 *
 * ## Process boundary
 *
 * Main-process (Node.js / Electron) module. No DOM APIs at module scope — the
 * DOM-reading snippets are strings handed to `pagePerception` /
 * `executeJavaScript`, which run inside the page. Every collaborator is injected
 * so the loop is unit-testable without a live window or network.
 */

import type { BrowserTabId, IBrowserViewManager } from './browserViewManager';
import type { IHumanLikeInput, InputSink, Point } from './humanLikeInput';

// ---------------------------------------------------------------------------
// Public event model (streamed to the renderer chat panel)
// ---------------------------------------------------------------------------

/** Role of a chat message in an agent conversation. */
export type AgentChatRole = 'user' | 'assistant';

/**
 * One streamed event from a running agent turn. The renderer renders these into
 * the chat transcript live.
 */
export type AgentEvent =
  /** The model decided to run a tool; `summary` is a short human label. */
  | { type: 'action'; tabId: BrowserTabId; tool: string; summary: string; detail?: string }
  /** Result/observation of the most recent action (truncated for display). */
  | { type: 'observation'; tabId: BrowserTabId; tool: string; ok: boolean; summary: string }
  /** The model produced its final answer for this turn. */
  | { type: 'final'; tabId: BrowserTabId; text: string }
  /** The turn failed (model/network/parse error or no model configured). */
  | { type: 'error'; tabId: BrowserTabId; message: string }
  /** The turn was stopped by the user before finishing. */
  | { type: 'stopped'; tabId: BrowserTabId };

/** Sink the runner pushes {@link AgentEvent}s through (the bridge forwards them to the renderer). */
export type AgentEventSink = (event: AgentEvent) => void;

/** A single prior turn in the chat, replayed into the model prompt for context. */
export type AgentHistoryMessage = { role: AgentChatRole; content: string };

/** Input to {@link IWebAgentRunner.run}. */
export type RunAgentRequest = {
  /** The tab the agent operates on. */
  tabId: BrowserTabId;
  /** The model id the user selected to drive the agent (criterion 1.2). */
  model: string;
  /** The new user instruction for this turn. */
  instruction: string;
  /**
   * Whether the agent is allowed to drive the tab the user is watching with
   * VISIBLE, interactive actions (scroll / click / type / navigate / press_key /
   * go_back / go_forward / reload). Defaults to `false`: by default the agent is
   * "invisible" — it only reads/scrapes and uses hidden background tabs, and the
   * interactive tools are reported as "permission required". The user grants this
   * per turn (e.g. an "allow control" toggle), exactly like a hand-over.
   */
  interactive?: boolean;
  /** Prior chat turns for context (most-recent last). Optional. */
  history?: AgentHistoryMessage[];
};

/** Result of a finished agent turn. */
export type RunAgentResult = {
  /** The final assistant answer (empty when stopped/errored before finishing). */
  answer: string;
  /** How the turn ended. */
  status: 'done' | 'stopped' | 'error' | 'max-steps';
  /** Number of tool steps executed. */
  steps: number;
};

/** Public contract of the web-agent runner. */
export type IWebAgentRunner = {
  /**
   * Run one agent turn against a tab, streaming progress through `onEvent` and
   * resolving with the final result. Reject only on programmer error; model /
   * network failures resolve with `status: 'error'` after emitting an `error`
   * event so the chat stays responsive.
   */
  run: (request: RunAgentRequest, onEvent: AgentEventSink) => Promise<RunAgentResult>;
  /** Request cancellation of the in-flight turn for a tab (best-effort, cooperative). */
  cancel: (tabId: BrowserTabId) => void;
};

// ---------------------------------------------------------------------------
// Injected collaborators
// ---------------------------------------------------------------------------

/**
 * A chat message content: plain text, or an OpenAI-compatible multimodal array
 * mixing text and image parts (used to feed the model a page screenshot for the
 * vision step). Providers that lack vision simply receive the text parts.
 */
export type ChatContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

/** One message in the model conversation. */
export type ChatMessageInput = { role: string; content: ChatContent };

/**
 * The chat-completion call the runner uses to think. Returns the raw assistant
 * message text. Production wiring supplies {@link createProviderChat} (reads the
 * user's provider from aioncore); tests inject a deterministic stub.
 */
export type AgentChat = (params: {
  model: string;
  messages: ChatMessageInput[];
  signal?: AbortSignal;
}) => Promise<string>;

/** Injected dependencies for {@link createWebAgentRunner}. */
export type WebAgentRunnerDeps = {
  /** Tab lifecycle + `WebContents` access (navigate / drive). */
  viewManager: IBrowserViewManager;
  /**
   * Read visible text from a tab (perception layer a — light, no lease). The
   * real `pagePerception.readText` satisfies this; narrowed to just the reader
   * so wiring does not need the (not-yet-implemented) media pipeline.
   */
  readText: (tabId: BrowserTabId, selector?: string) => Promise<string>;
  /**
   * Capture the tab as a PNG data-URL for the vision step (perception layer b —
   * medium). Heavy, so the implementation MUST acquire/release a `'browser'`
   * lease internally (criterion 1.9). Optional: when omitted the `screenshot`
   * tool is disabled and reported as unavailable to the model.
   */
  capture?: (tabId: BrowserTabId) => Promise<string>;
  /** Builds a human-like input emitter over a tab's {@link InputSink} (criterion 1.3). */
  createInput: (sink: InputSink) => IHumanLikeInput;
  /** The model call used for reasoning. */
  chat: AgentChat;
  /**
   * Personal-agent memory (optional). When provided, the runner prepends the
   * persona to its system prompt, injects the current site's notes as context,
   * and exposes a `remember` tool so the agent can persist a note. Omitted in
   * tests that don't exercise memory.
   */
  memory?: AgentMemory;
  /**
   * Map-reduce summariser (optional). When provided, the `summarize` tool
   * extracts the page's MAIN content and summarises it without the 4000-char
   * observation truncation, so long articles/transcripts are covered in full.
   * When omitted, `summarize` is reported as unavailable.
   */
  summarizer?: AgentSummarizer;
  /**
   * Deep, multi-source research (optional). When provided, the `deep_research`
   * tool plans sub-queries, reads several sources in hidden tabs, and returns a
   * cited synthesis. When omitted, `deep_research` falls back to `research`.
   */
  deepResearch?: AgentDeepResearch;
  /**
   * Extract the MAIN readable content of a tab (readability). Used by `summarize`
   * to avoid feeding nav/ads/footers to the model. Optional; when omitted
   * `summarize` falls back to {@link WebAgentRunnerDeps.readText}.
   */
  readMainContent?: (tabId: BrowserTabId) => Promise<{ title: string; text: string }>;
  /**
   * Server-side YouTube transcript fetcher (Main-process HTTP, anonymous clean
   * session — the Comet/yt-dlp approach). When provided it is the FAST, reliable
   * primary path for `video_transcript` (no tab, no PO-token gate); the in-page
   * extraction remains as a fallback. Optional; omitted in tests that don't
   * exercise it.
   */
  fetchTranscript?: (urlOrId: string) => Promise<{ ok: boolean; text?: string; lang?: string; reason?: string }>;
  /** Max tool steps before the loop force-finishes (safety bound). Default 12. */
  maxSteps?: number;
  /** Delay primitive (ms). Defaults to `setTimeout`. Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Map-reduce summariser hook (a structural subset of `ISummarizer`). Injected so
 * the runner stays decoupled from the concrete summariser and unit-testable.
 */
export type AgentSummarizer = {
  /** Summarise (possibly long) text; `focus` carries the user's intent. */
  summarize: (
    text: string,
    options: { model: string; focus?: string; language?: string; signal?: AbortSignal }
  ) => Promise<{ summary: string; chunks: number }>;
};

/**
 * Deep-research hook (a structural subset of `IDeepResearch`). Injected so the
 * runner stays decoupled from the concrete orchestrator and unit-testable.
 */
export type AgentDeepResearch = {
  /** Research a question end-to-end, returning a cited answer + numbered sources. */
  research: (
    question: string,
    options: { model: string; language?: string; signal?: AbortSignal },
    onProgress?: (progress: { phase: string; [key: string]: unknown }) => void
  ) => Promise<{ answer: string; sources: Array<{ index: number; title: string; url: string }>; subQueries: string[] }>;
};

/**
 * Personal-memory hooks the runner uses (a structural subset of
 * `IBrowserMemory`). Injected so the runner stays decoupled from the concrete
 * file store and unit-testable.
 */
export type AgentMemory = {
  /** Global persona instruction prepended to the system prompt. */
  getPersona: () => Promise<string>;
  /** Recall notes for a host (most-recent last). */
  getSiteNotes: (host: string) => Promise<Array<{ text: string; at: number }>>;
  /** Persist a note for a host. */
  addSiteNote: (host: string, text: string) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Tool protocol
// ---------------------------------------------------------------------------

/** The actions the model may request. Kept deliberately small and robust. */
type AgentAction =
  | { tool: 'navigate'; url: string }
  | { tool: 'read_text'; selector?: string }
  | { tool: 'click'; selector: string }
  | { tool: 'type'; selector: string; text: string }
  | { tool: 'scroll'; direction: 'up' | 'down'; amount?: number }
  | { tool: 'screenshot' }
  | { tool: 'go_back' }
  | { tool: 'go_forward' }
  | { tool: 'reload' }
  | { tool: 'wait_for'; selector: string; timeoutMs?: number }
  | { tool: 'press_key'; key: string }
  | { tool: 'remember'; note: string }
  | { tool: 'video_transcript' }
  | { tool: 'analyze_audio' }
  | { tool: 'research'; query?: string; url?: string }
  | { tool: 'summarize'; selector?: string }
  | { tool: 'deep_research'; query: string }
  | { tool: 'finish'; answer: string };

/** Max characters of an observation echoed back into the model prompt. */
const MAX_OBSERVATION_CHARS = 4000;

/** Max characters of an observation surfaced to the UI (shorter than the model sees). */
const MAX_UI_SUMMARY_CHARS = 200;

/**
 * Detects a "summarize this video/page" intent so the runner can take the
 * one-shot fast path (extract once → single model call) instead of the slower
 * multi-step ReAct loop. Matches common English + Vietnamese phrasings.
 */
const SUMMARY_INTENT_RE =
  /\b(summar(y|ize|ise)|tl;?dr|recap)\b|tóm\s*tắt|tóm\s*lược|nội\s*dung\s*(chính|video|trang)|video\s*(này|nói\s*gì)|nói\s*về\s*(cái\s*)?gì/i;

/** Default ceiling on tool steps per turn. */
const DEFAULT_MAX_STEPS = 12;

/** Default timeout (ms) for the `wait_for` tool. */
const DEFAULT_WAIT_TIMEOUT_MS = 8000;

/** Poll interval (ms) for the `wait_for` tool. */
const DEFAULT_WAIT_INTERVAL_MS = 250;

/** Origin cursor position assumed before a tab's first pointer interaction. */
const ORIGIN: Point = { x: 0, y: 0 };

/**
 * Off-screen viewport size for HIDDEN background tabs (research / transcript).
 * A hidden tab defaults to a 0×0 `WebContentsView`, but lazy-loading SPAs like
 * YouTube only mount their UI (e.g. the "Show transcript" button) when they have
 * a real viewport — so a 0×0 tab silently fails to initialise. Giving the hidden
 * tab a normal desktop size makes those pages render fully while it stays
 * invisible and muted.
 */
const HIDDEN_TAB_BOUNDS = { x: 0, y: 0, width: 1280, height: 900 };

/**
 * In-page snippet (runs inside the tab, not Node) that extracts a video's
 * spoken transcript **passively** — it ONLY reads data and fetches caption
 * files. It never clicks, scrolls, toggles captions, or changes a text-track's
 * mode, so it is safe to run on the tab the user is watching without disturbing
 * it (the "the agent scrolled my page" complaint). Sources, most reliable first:
 *
 * 1. YouTube **InnerTube `get_transcript`** — session-authenticated POST that
 *    works inside the user's real Chromium login where the public `timedtext`
 *    URL now returns an empty 200 (YouTube gates it behind a PO token).
 * 2. YouTube **`timedtext`** — read `ytInitialPlayerResponse` caption tracks and
 *    fetch each `baseUrl` (JSON3 then XML). Kept as a fallback.
 * 3. HTML5 `<video>` — read cues from any ALREADY-loaded `<track>` (no mode change).
 * 4. An ALREADY-open transcript panel — passive scrape only.
 *
 * Returns the transcript string, or `__NOCAP__:<reason>` when nothing passive
 * worked (the caller then retries the active path in a HIDDEN tab — see
 * {@link VIDEO_TRANSCRIPT_ACTIVE_SCRIPT}).
 */
const VIDEO_TRANSCRIPT_SCRIPT = `(async () => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const tried = [];
  const getVideoId = () => {
    try {
      const u = new URL(location.href);
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const parts = u.pathname.split('/').filter(Boolean);
      const i = parts.indexOf('shorts');
      if (i !== -1 && parts[i + 1]) return parts[i + 1];
      if (u.hostname.includes('youtu.be') && parts[0]) return parts[0];
    } catch (e) {}
    return '';
  };
  const getPlayerResponse = () => {
    if (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.captions) return window.ytInitialPlayerResponse;
    try {
      const mp = document.querySelector('#movie_player');
      if (mp && typeof mp.getPlayerResponse === 'function') { const r = mp.getPlayerResponse(); if (r && r.captions) return r; }
    } catch (e) {}
    try {
      for (const sc of Array.from(document.scripts)) {
        const t = sc.textContent || '';
        const i = t.indexOf('ytInitialPlayerResponse');
        if (i !== -1) {
          const start = t.indexOf('{', i);
          if (start !== -1) {
            let depth = 0;
            for (let j = start; j < t.length; j++) {
              if (t[j] === '{') depth++;
              else if (t[j] === '}') { depth--; if (depth === 0) { try { const r = JSON.parse(t.slice(start, j + 1)); if (r && r.captions) return r; } catch (e) {} break; } }
            }
          }
        }
      }
    } catch (e) {}
    return window.ytInitialPlayerResponse || null;
  };
  // Fetch one caption track, trying json3 then plain XML (more stable when json3 is empty).
  const fetchTrack = async (baseUrl) => {
    const clean2 = (u) => u.replace(/&fmt=[^&]*/g, '');
    for (const suffix of ['&fmt=json3', '']) {
      try {
        const res = await fetch(clean2(baseUrl) + suffix, { credentials: 'include' });
        if (!res.ok) { tried.push('fetch ' + res.status); continue; }
        const body = await res.text();
        if (!body) { tried.push('empty body'); continue; }
        if (suffix) {
          const data = JSON.parse(body);
          const text = clean((data.events || []).map((e) => (e.segs || []).map((s) => s.utf8).join('')).join(' '));
          if (text) return text;
        } else {
          const doc = new DOMParser().parseFromString(body, 'text/xml');
          const nodes = Array.from(doc.querySelectorAll('text'));
          const text = clean(nodes.map((n) => n.textContent).join(' '));
          if (text) return text;
        }
      } catch (e) { tried.push('err ' + (e && e.message)); }
    }
    return '';
  };
  // Read a value from YouTube's runtime config (INNERTUBE_* etc.).
  const cfgGet = (k) => {
    try {
      if (window.ytcfg && typeof window.ytcfg.get === 'function') return window.ytcfg.get(k);
      if (window.ytcfg && window.ytcfg.data_) return window.ytcfg.data_[k];
    } catch (e) {}
    return null;
  };
  // Read ytInitialData from the window or by scanning inline scripts.
  const getInitialData = () => {
    if (window.ytInitialData) return window.ytInitialData;
    try {
      for (const sc of Array.from(document.scripts)) {
        const t = sc.textContent || '';
        const i = t.indexOf('ytInitialData');
        if (i !== -1) {
          const start = t.indexOf('{', i);
          if (start !== -1) {
            let depth = 0;
            for (let j = start; j < t.length; j++) {
              if (t[j] === '{') depth++;
              else if (t[j] === '}') { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, j + 1)); } catch (e) {} break; } }
            }
          }
        }
      }
    } catch (e) {}
    return null;
  };
  // Breadth/depth scan for the first occurrence of a key anywhere in an object.
  const deepFindKey = (root, key) => {
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (cur[key] != null) return cur[key];
      for (const k in cur) { const v = cur[k]; if (v && typeof v === 'object') stack.push(v); }
    }
    return null;
  };
  // Collect every transcript segment's text from an InnerTube get_transcript response.
  const collectSegments = (root) => {
    const out = [];
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (o.transcriptSegmentRenderer) {
        const sn = o.transcriptSegmentRenderer.snippet;
        const txt = sn ? (sn.simpleText || (sn.runs || []).map((r) => r.text || '').join('')) : '';
        if (txt) out.push(txt);
        return;
      }
      if (Array.isArray(o)) { for (const x of o) walk(x); return; }
      for (const k in o) walk(o[k]);
    };
    walk(root);
    return out;
  };
  // Primary path: InnerTube get_transcript. Pure fetch inside the page's own
  // logged-in session (no DOM clicking, no scrolling — never disturbs the user's
  // tab), and far more reliable than timedtext now that baseUrl needs a PO token.
  // Modern InnerTube REJECTS requests (HTTP 400) that lack the client-identity
  // headers, so we send them exactly like youtube.com's own player does, read
  // from ytcfg. Same-origin fetch sends the login cookies automatically.
  const itHeaders = () => {
    const h = { 'Content-Type': 'application/json' };
    try {
      const name = cfgGet('INNERTUBE_CONTEXT_CLIENT_NAME');
      const ver = cfgGet('INNERTUBE_CONTEXT_CLIENT_VERSION') || cfgGet('INNERTUBE_CLIENT_VERSION');
      const visitor = cfgGet('VISITOR_DATA');
      if (name != null) h['X-Youtube-Client-Name'] = String(name);
      if (ver) h['X-Youtube-Client-Version'] = String(ver);
      if (visitor) h['X-Goog-Visitor-Id'] = String(visitor);
    } catch (e) {}
    return h;
  };
  const itPost = async (path, body) => {
    return fetch(path, { method: 'POST', headers: itHeaders(), credentials: 'include', body: JSON.stringify(body) });
  };
  try {
    const apiKey = cfgGet('INNERTUBE_API_KEY');
    const ctx = cfgGet('INNERTUBE_CONTEXT');
    const initial = getInitialData();
    let ep = initial ? deepFindKey(initial, 'getTranscriptEndpoint') : null;
    let params = ep && ep.params;
    // The transcript params are usually NOT in the watch page's initial data.
    // Fetch them from the InnerTube /next endpoint (session-authenticated, no
    // scraping, no playback) — the same source youtubei.js uses. This is what
    // makes the transcript work without the slow click-the-panel fallback.
    if (apiKey && ctx && !params) {
      const vid = getVideoId();
      if (vid) {
        try {
          const nres = await itPost('/youtubei/v1/next?key=' + encodeURIComponent(apiKey), { context: ctx, videoId: vid });
          if (nres.ok) {
            const ndata = await nres.json();
            ep = deepFindKey(ndata, 'getTranscriptEndpoint');
            params = ep && ep.params;
          } else { tried.push('next ' + nres.status); }
        } catch (e) { tried.push('next err ' + (e && e.message)); }
      }
    }
    if (apiKey && ctx && params) {
      const res = await itPost('/youtubei/v1/get_transcript?key=' + encodeURIComponent(apiKey), { context: ctx, params });
      if (res.ok) {
        const data = await res.json();
        const text = clean(collectSegments(data).join(' '));
        if (text) return ('[innertube] ' + text).slice(0, 40000);
        tried.push('innertube empty');
      } else {
        let detail = '';
        try { detail = (await res.text()).slice(0, 120); } catch (e) {}
        tried.push('innertube ' + res.status + (detail ? ' ' + detail.replace(/\\s+/g, ' ') : ''));
      }
    } else {
      tried.push('innertube no ' + (!apiKey ? 'apiKey' : !ctx ? 'ctx' : 'params'));
    }
  } catch (e) { tried.push('innertube err ' + (e && e.message)); }
  try {
    const pr = getPlayerResponse();
    const tracks = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (tracks && tracks.length) {
      const ordered = [
        ...tracks.filter((t) => (t.languageCode || '').startsWith('vi')),
        ...tracks.filter((t) => (t.languageCode || '').startsWith('en')),
        ...tracks,
      ];
      for (const track of ordered) {
        if (track && track.baseUrl) {
          const text = await fetchTrack(track.baseUrl);
          if (text) return ('[' + (track.languageCode || '?') + (track.kind === 'asr' ? ' auto' : '') + '] ' + text).slice(0, 40000);
        }
      }
      tried.push(tracks.length + ' track(s) but all fetches empty');
    } else {
      tried.push('no captionTracks in player response');
    }
  } catch (e) { tried.push('pr err ' + (e && e.message)); }
  try {
    // HTML5 <video> text tracks — read ONLY already-loaded cues; do NOT change
    // the track mode (changing it would flip captions on for the user).
    const video = document.querySelector('video');
    if (video && video.textTracks && video.textTracks.length) {
      for (const tt of Array.from(video.textTracks)) {
        const cues = tt.cues ? Array.from(tt.cues) : [];
        if (cues.length) {
          const text = clean(cues.map((c) => c.text).join(' '));
          if (text) return text.slice(0, 40000);
        }
      }
    }
  } catch (e) {}
  try {
    // An ALREADY-open transcript panel (passive scrape — only if the user opened it).
    const seg = document.querySelectorAll('ytd-transcript-segment-renderer, .ytd-transcript-segment-renderer, [class*=transcript] [class*=segment]');
    if (seg && seg.length) {
      const text = clean(Array.from(seg).map((n) => n.textContent).join(' '));
      if (text) return text.slice(0, 40000);
    }
  } catch (e) {}
  // Nothing passive worked. Do NOT click/scroll/toggle on the user's visible tab
  // — return a reason so the caller can retry the ACTIVE path in a hidden tab.
  return '__NOCAP__:' + (tried.join('; ') || 'no source');
})()`;

/**
 * In-page snippet that extracts a YouTube transcript by **actively** mutating
 * the page: expand the description ("...more"), click "Show transcript", then
 * scrape the panel. Because it clicks and changes the DOM it MUST run ONLY in a
 * **hidden background tab**, never on the tab the user is watching.
 *
 * The old "turn captions on and sample on-screen text" last-resort was removed:
 * it produced only partial `[on-screen]` fragments, took ~13s, and needs active
 * playback (which a freshly-opened hidden tab does not have).
 *
 * Returns the transcript string, or `__NOCAP__:<reason>` on failure.
 */
const VIDEO_TRANSCRIPT_ACTIVE_SCRIPT = `(async () => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const tried = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Poll a predicate until it returns truthy or the deadline passes.
  const waitFor = async (fn, timeoutMs, stepMs) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      if (Date.now() >= end) return null;
      await sleep(stepMs || 250);
    }
  };
  const segText = () => {
    const seg = document.querySelectorAll('ytd-transcript-segment-renderer, .ytd-transcript-segment-renderer');
    if (!seg || !seg.length) return '';
    // Use only the caption text, dropping the leading timestamp of each segment.
    return clean(Array.from(seg).map((n) => {
      const cue = n.querySelector('.segment-text, [class*=segment-text]');
      return (cue ? cue.textContent : (n.textContent || '')).trim();
    }).join(' '));
  };
  const findByText = (sel, re) => Array.from(document.querySelectorAll(sel)).find((n) => re.test((n.textContent || '') + ' ' + (n.getAttribute('aria-label') || '')));
  const TRANSCRIPT_RE = /transcript|bản chép|phụ đề|字幕|자막|стенограм|transcripción|transcription/i;
  try {
    // 1. Wait for the watch page primary content to exist (the hidden tab may
    //    still be loading — this is why a fixed 1.5s wait was unreliable).
    await waitFor(() => document.querySelector('#primary #below, ytd-watch-metadata, #movie_player'), 12000, 300);
    // 2. If a transcript panel is already present, just read it.
    let text = segText();
    if (text) return ('[panel] ' + text).slice(0, 40000);
    // 3. Expand the description ("...more") so the transcript button is in the DOM.
    const expand = await waitFor(() => document.querySelector('tp-yt-paper-button#expand, #expand, ytd-text-inline-expander #expand'), 6000, 300);
    if (expand) { expand.click(); await sleep(500); }
    // 4. Find the "Show transcript" button — directly, or inside the "...more"
    //    actions menu. Poll because it renders asynchronously.
    let btn = await waitFor(
      () => document.querySelector('button[aria-label*="transcript" i], button[aria-label*="bản chép" i]') ||
            findByText('button, yt-button-shape button, ytd-button-renderer, tp-yt-paper-item, ytd-menu-service-item-renderer', TRANSCRIPT_RE),
      8000,
      300
    );
    if (!btn) {
      // Open the "...more actions" overflow menu, then look again.
      const more = document.querySelector('#button-shape > button[aria-label*="More" i], ytd-menu-renderer #button, button[aria-label*="thao tác khác" i]');
      if (more) {
        more.click();
        await sleep(500);
        btn = await waitFor(() => findByText('tp-yt-paper-item, ytd-menu-service-item-renderer, button, yt-button-shape button', TRANSCRIPT_RE), 4000, 300);
      }
    }
    if (!btn) { tried.push('no transcript button'); return '__NOCAP__:' + tried.join('; '); }
    btn.click();
    // 5. Wait for the panel segments to render.
    text = await waitFor(() => { const t = segText(); return t || null; }, 10000, 300);
    if (text) return ('[panel] ' + text).slice(0, 40000);
    tried.push('opened transcript but no segments');
  } catch (e) { tried.push('panel err ' + (e && e.message)); }
  return '__NOCAP__:' + (tried.join('; ') || 'no source');
})()`;

/**
 * In-page snippet (runs inside the tab) that analyzes the currently playing
 * audio's frequency profile via the Web Audio API. It samples the FFT for a
 * short window and reports relative energy in bass / low-mid / mid / high bands
 * plus a rough "brightness" (spectral centroid) so the agent can describe how
 * high/low the music sounds. Best-effort: returns '' when no media is playing or
 * the browser blocks the capture. Tapped through a gain passthrough so playback
 * is not muted.
 */
const ANALYZE_AUDIO_SCRIPT = `(async () => {
  try {
    const media = Array.from(document.querySelectorAll('video, audio')).find((m) => !m.paused && !m.muted && m.readyState >= 2) || document.querySelector('video, audio');
    if (!media) return '';
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return '';
    if (!window.__aionAudioCtx) window.__aionAudioCtx = new Ctx();
    const ctx = window.__aionAudioCtx;
    try { await ctx.resume(); } catch (e) {}
    if (!media.__aionSrc) {
      media.__aionSrc = ctx.createMediaElementSource(media);
      media.__aionAnalyser = ctx.createAnalyser();
      media.__aionAnalyser.fftSize = 2048;
      media.__aionSrc.connect(media.__aionAnalyser);
      media.__aionSrc.connect(ctx.destination); // passthrough so audio still plays
    }
    const analyser = media.__aionAnalyser;
    const bins = analyser.frequencyBinCount;
    const data = new Uint8Array(bins);
    const sampleRate = ctx.sampleRate;
    // Average several frames over ~600ms for a stable reading.
    const acc = new Float64Array(bins);
    const frames = 12;
    for (let f = 0; f < frames; f++) {
      analyser.getByteFrequencyData(data);
      for (let i = 0; i < bins; i++) acc[i] += data[i];
      await new Promise((r) => setTimeout(r, 50));
    }
    for (let i = 0; i < bins; i++) acc[i] /= frames;
    const hzPerBin = (sampleRate / 2) / bins;
    const band = (lo, hi) => { let s = 0, n = 0; for (let i = 0; i < bins; i++) { const hz = i * hzPerBin; if (hz >= lo && hz < hi) { s += acc[i]; n++; } } return n ? s / n : 0; };
    const bass = band(20, 250), lowMid = band(250, 800), mid = band(800, 2500), high = band(2500, 8000), air = band(8000, 16000);
    let num = 0, den = 0; for (let i = 0; i < bins; i++) { num += i * hzPerBin * acc[i]; den += acc[i]; }
    const centroid = den ? Math.round(num / den) : 0;
    const total = bass + lowMid + mid + high + air || 1;
    const pct = (x) => Math.round((x / total) * 100);
    const tone = centroid < 700 ? 'low / bass-heavy' : centroid < 2000 ? 'balanced / warm mid' : 'bright / treble-heavy';
    return 'Audio frequency profile (relative energy): bass ' + pct(bass) + '%, low-mid ' + pct(lowMid) + '%, mid ' + pct(mid) + '%, high ' + pct(high) + '%, air ' + pct(air) + '%. Spectral centroid ~' + centroid + ' Hz (' + tone + ').';
  } catch (e) {
    return '';
  }
})()`;

/** Map a friendly key name to an Electron `sendInputEvent` keyCode. */
const normalizeKeyCode = (key: string): string => {
  const named: Record<string, string> = {
    enter: 'Return',
    return: 'Return',
    tab: 'Tab',
    escape: 'Escape',
    esc: 'Escape',
    backspace: 'Backspace',
    delete: 'Delete',
    space: 'Space',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
  };
  return named[key.toLowerCase()] ?? key;
};

/** Normalize a bare host into an https URL (mirrors the renderer `normalizeUrl`). */
const ensureScheme = (url: string): string => (/^[a-zA-Z][\w+.-]*:\/\//.test(url) ? url : `https://${url}`);

/** Extract the host (origin key) from a URL; returns '' for unparseable input. */
const hostOfUrl = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Truncate text for prompt/observation use. */
const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);

/**
 * System prompt teaching the model the JSON tool protocol. Intentionally
 * explicit: respond with ONE fenced ```json block containing exactly one action.
 */
const SYSTEM_PROMPT = `You are a web-browsing agent controlling a single real browser tab on the user's behalf.
You see the page only through the tools below — you cannot see the screen directly.

Respond with EXACTLY ONE JSON object wrapped in a \`\`\`json code fence, and nothing else.
The JSON must have a "tool" field naming one action, plus that action's arguments:

- {"tool":"navigate","url":"https://example.com"}      → load a URL in the tab
- {"tool":"read_text","selector":"main"}                 → read visible text (selector optional; omit for whole page)
- {"tool":"click","selector":"button.login"}             → click the first element matching a CSS selector
- {"tool":"type","selector":"input[name=q]","text":"hi"} → focus a field and type text
- {"tool":"scroll","direction":"down","amount":600}      → scroll the page (amount in px, optional)
- {"tool":"screenshot"}                                  → capture the page as an image so you can SEE it (use when text/selectors are not enough)
- {"tool":"go_back"}                                     → go back in the tab history
- {"tool":"go_forward"}                                  → go forward in the tab history
- {"tool":"reload"}                                      → reload the current page
- {"tool":"wait_for","selector":"#results","timeoutMs":8000} → wait until an element appears (after a click/navigation)
- {"tool":"press_key","key":"Enter"}                     → press a single key (e.g. Enter, Tab, Escape)
- {"tool":"remember","note":"..."}                       → save a short note about THIS site for future visits
- {"tool":"video_transcript"}                            → extract the spoken transcript/captions of a video on the page (so you can summarize what it SAYS)
- {"tool":"analyze_audio"}                                → analyze the playing audio's frequency profile (bass/mid/treble, how high/low it sounds)
- {"tool":"research","query":"..."}                       → look something up WITHOUT leaving the current page: opens a hidden background tab, reads it, closes it. Optionally pass a specific {"url":"..."} instead of a query.
- {"tool":"summarize"}                                    → extract the page's MAIN article text and summarize it in full (handles long pages without truncation). Use this for "summarize this article/page" instead of read_text.
- {"tool":"deep_research","query":"..."}                  → in-depth multi-source research: plans sub-questions, reads several sources in hidden tabs, and returns a synthesised answer WITH numbered [n] citations. Use for open-ended questions needing several sources (e.g. "compare X vs Y", "what's the latest on Z").
- {"tool":"finish","answer":"..."}                       → you are done; give the final answer to the user

Rules:
- Take ONE action per message. After each action you receive an observation, then choose the next action.
- Prefer read_text to understand a page before clicking. Use precise CSS selectors.
- Use screenshot when the page is visual or selectors fail — the captured image is sent to you on the next turn so you can decide where to click.
- To understand what a video SAYS (e.g. "summarize this video"), call video_transcript ONCE on the current page, then summarize the returned text. It reads captions passively and, if needed, retries in a hidden tab — you do NOT need to scroll, click "Show transcript", or open any panel yourself.
- **NEVER use navigate to go look something up.** navigate changes the tab the USER is watching. To find external info (e.g. song lyrics, facts), ALWAYS use research — it works in a hidden background tab and never disturbs the user's current page. Only use navigate when the user explicitly asks to go to a page.
- If video_transcript finds no captions (common for music videos), use research to find the lyrics/info instead, or analyze_audio to describe the sound.
- To summarize a long article or page, prefer summarize (it reads the main content and won't be cut off) over read_text.
- For open-ended questions that need several sources or comparison, prefer deep_research over research — it reads multiple pages and cites them.
- After a click or navigation that loads new content, use wait_for to let it settle before reading.
- When the task is complete, or you have the information requested, call "finish" with a helpful answer.
- Answer the user in the same language they used. Be concise.`;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Extract the first JSON object from a model reply (fenced or bare). */
const extractJson = (reply: string): string | null => {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) return fenced[1].trim();
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start !== -1 && end > start) return reply.slice(start, end + 1).trim();
  return null;
};

/** Parse a model reply into an {@link AgentAction}, or `null` when malformed. */
const parseAction = (reply: string): AgentAction | null => {
  const json = extractJson(reply);
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const tool = obj.tool;
  switch (tool) {
    case 'navigate':
      return typeof obj.url === 'string' ? { tool, url: obj.url } : null;
    case 'read_text':
      return { tool, selector: typeof obj.selector === 'string' ? obj.selector : undefined };
    case 'click':
      return typeof obj.selector === 'string' ? { tool, selector: obj.selector } : null;
    case 'type':
      return typeof obj.selector === 'string' && typeof obj.text === 'string'
        ? { tool, selector: obj.selector, text: obj.text }
        : null;
    case 'scroll': {
      const direction = obj.direction === 'up' ? 'up' : 'down';
      const amount = typeof obj.amount === 'number' ? obj.amount : undefined;
      return { tool: 'scroll', direction, amount };
    }
    case 'screenshot':
      return { tool: 'screenshot' };
    case 'go_back':
      return { tool: 'go_back' };
    case 'go_forward':
      return { tool: 'go_forward' };
    case 'reload':
      return { tool: 'reload' };
    case 'wait_for':
      return typeof obj.selector === 'string'
        ? {
            tool: 'wait_for',
            selector: obj.selector,
            timeoutMs: typeof obj.timeoutMs === 'number' ? obj.timeoutMs : undefined,
          }
        : null;
    case 'press_key':
      return typeof obj.key === 'string' ? { tool: 'press_key', key: obj.key } : null;
    case 'remember':
      return typeof obj.note === 'string' ? { tool: 'remember', note: obj.note } : null;
    case 'video_transcript':
      return { tool: 'video_transcript' };
    case 'analyze_audio':
      return { tool: 'analyze_audio' };
    case 'research':
      return {
        tool: 'research',
        query: typeof obj.query === 'string' ? obj.query : undefined,
        url: typeof obj.url === 'string' ? obj.url : undefined,
      };
    case 'summarize':
      return { tool: 'summarize', selector: typeof obj.selector === 'string' ? obj.selector : undefined };
    case 'deep_research':
      return typeof obj.query === 'string' ? { tool: 'deep_research', query: obj.query } : null;
    case 'finish':
      return { tool, answer: typeof obj.answer === 'string' ? obj.answer : '' };
    default:
      return null;
  }
};

/** A short, human-friendly label for an action (shown in the chat narration). */
const actionSummary = (action: AgentAction): { summary: string; detail?: string } => {
  switch (action.tool) {
    case 'navigate':
      return { summary: `navigate(${action.url})`, detail: action.url };
    case 'read_text':
      return { summary: action.selector ? `read_text(${action.selector})` : 'read_text()' };
    case 'click':
      return { summary: `click(${action.selector})` };
    case 'type':
      return { summary: `type(${action.selector})`, detail: action.text };
    case 'scroll':
      return { summary: `scroll(${action.direction}${action.amount ? `, ${action.amount}px` : ''})` };
    case 'screenshot':
      return { summary: 'screenshot()' };
    case 'go_back':
      return { summary: 'go_back()' };
    case 'go_forward':
      return { summary: 'go_forward()' };
    case 'reload':
      return { summary: 'reload()' };
    case 'wait_for':
      return { summary: `wait_for(${action.selector})` };
    case 'press_key':
      return { summary: `press_key(${action.key})` };
    case 'remember':
      return { summary: 'remember()', detail: action.note };
    case 'video_transcript':
      return { summary: 'video_transcript()' };
    case 'analyze_audio':
      return { summary: 'analyze_audio()' };
    case 'research':
      return { summary: `research(${action.url ?? action.query ?? ''})`, detail: action.url ?? action.query };
    case 'summarize':
      return { summary: action.selector ? `summarize(${action.selector})` : 'summarize()' };
    case 'deep_research':
      return { summary: `deep_research(${action.query})`, detail: action.query };
    case 'finish':
      return { summary: 'finish' };
  }
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an {@link IWebAgentRunner} from injected collaborators.
 */
export const createWebAgentRunner = (deps: WebAgentRunnerDeps): IWebAgentRunner => {
  const { viewManager, readText, capture, createInput, chat, memory } = deps;
  const { summarizer, deepResearch, readMainContent, fetchTranscript } = deps;
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))));

  /** Per-tab cancellation tokens so `cancel(tabId)` can abort an in-flight turn. */
  const cancellations = new Map<BrowserTabId, AbortController>();
  /** Per-tab last cursor position so pointer moves start where they left off. */
  const cursors = new Map<BrowserTabId, Point>();

  /** Build an InputSink over a tab's WebContents (criterion 1.3 — tab-isolated input). */
  const buildInputSink = (tabId: BrowserTabId): InputSink | null => {
    const contents = viewManager.getWebContents(tabId);
    if (!contents) return null;
    return {
      sendMouseMove: (x, y) => contents.sendInputEvent({ type: 'mouseMove', x, y }),
      sendMouseDown: (x, y, button) => contents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 }),
      sendMouseUp: (x, y, button) => contents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 }),
      sendKeyChar: (ch) => contents.sendInputEvent({ type: 'char', keyCode: ch }),
    };
  };

  /** Resolve an element's centre point in the page via executeJavaScript. */
  const resolveSelectorPoint = async (tabId: BrowserTabId, selector: string): Promise<Point | null> => {
    const contents = viewManager.getWebContents(tabId);
    if (!contents) return null;
    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`;
    const result: unknown = await contents.executeJavaScript(script);
    if (result && typeof result === 'object' && 'x' in result && 'y' in result) {
      const p = result as { x: unknown; y: unknown };
      if (typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y };
    }
    return null;
  };

  /**
   * Extract a video transcript: PASSIVE first (read-only, on the visible tab —
   * InnerTube get_transcript / timedtext / loaded cues), and only if that yields
   * nothing, the ACTIVE path (clicks "Show transcript") in a HIDDEN tab cloned
   * from the current URL so the user's visible tab is never disturbed. Shared by
   * the `video_transcript` tool and the one-shot summarize-video fast path.
   */
  const extractTranscript = async (tabId: BrowserTabId): Promise<{ text: string; reason: string }> => {
    const info = viewManager.listTabs().find((tab) => tab.id === tabId);
    const url = info?.url ?? '';
    // FAST PATH — server-side fetch from Main process (anonymous clean session,
    // the Comet/yt-dlp approach): just HTTP, no tab to open, not gated by the
    // logged-in PO-token wall. This is the reliable primary for YouTube.
    let primaryReason = '';
    if (fetchTranscript && /^https?:\/\//i.test(url)) {
      try {
        const out = await fetchTranscript(url);
        if (out.ok && out.text && out.text.trim().length > 0) {
          return { text: out.text.trim(), reason: '' };
        }
        primaryReason = out.ok ? '' : (out.reason ?? '');
        // A rate-limit / "no captions" verdict from yt-dlp is the AUTHORITATIVE
        // answer (it ran against an anonymous clean session). The in-page path
        // would only echo a confusing "innertube 400" for the same video, so
        // surface the clear yt-dlp reason instead of falling through.
        if (/rate-limited|no captions available/i.test(primaryReason)) {
          return { text: '', reason: primaryReason };
        }
      } catch {
        // fall through to in-page extraction
      }
    }
    const contents = viewManager.getWebContents(tabId);
    if (!contents) return { text: '', reason: primaryReason || 'tab not available' };
    const rawPassive = await contents
      .executeJavaScript(VIDEO_TRANSCRIPT_SCRIPT)
      .catch((e: unknown) => `__NOCAP__:passive threw ${e instanceof Error ? e.message : String(e)}`);
    const passive = typeof rawPassive === 'string' ? rawPassive.trim() : '';
    if (passive.length > 0 && !passive.startsWith('__NOCAP__')) {
      return { text: passive, reason: '' };
    }
    // Active fallback in a hidden tab cloned from the current URL.
    if (/^https?:\/\//i.test(url)) {
      let hiddenId: BrowserTabId | undefined;
      try {
        hiddenId = viewManager.createTab({ visible: false, bounds: HIDDEN_TAB_BOUNDS });
        await viewManager.loadURL(hiddenId, url);
        await sleep(500); // brief settle; the active script polls for readiness itself
        const hidden = viewManager.getWebContents(hiddenId);
        const rawActive = hidden ? await hidden.executeJavaScript(VIDEO_TRANSCRIPT_ACTIVE_SCRIPT) : '';
        const active = typeof rawActive === 'string' ? rawActive.trim() : '';
        if (active.length > 0 && !active.startsWith('__NOCAP__')) {
          return { text: active, reason: '' };
        }
      } catch {
        // fall through
      } finally {
        if (hiddenId) viewManager.destroyTab(hiddenId);
      }
    }
    const reason = passive.startsWith('__NOCAP__') ? passive.slice('__NOCAP__:'.length).trim() : 'no source';
    return { text: '', reason };
  };

  /** Execute one action against the live tab, returning an observation string (and an optional captured image). */
  const executeAction = async (
    tabId: BrowserTabId,
    action: AgentAction,
    model: string,
    signal?: AbortSignal,
    interactive = false
  ): Promise<{ ok: boolean; observation: string; image?: string }> => {
    // Permission gate: the tools that VISIBLY drive the tab the user is watching
    // are blocked unless the user granted control for this turn. By default the
    // agent stays invisible (read/scrape + hidden tabs). It is NOT an error — the
    // model is told to fall back to read_text/summarize/research/deep_research.
    const INTERACTIVE_TOOLS: ReadonlyArray<AgentAction['tool']> = [
      'navigate',
      'click',
      'type',
      'scroll',
      'press_key',
      'go_back',
      'go_forward',
      'reload',
    ];
    if (!interactive && INTERACTIVE_TOOLS.includes(action.tool)) {
      return {
        ok: false,
        observation: `Permission required: "${action.tool}" controls the page the user is watching and is disabled. The user has NOT granted control this turn. Do NOT retry interactive tools — instead read the page (read_text), summarize it (summarize), or use research/deep_research in hidden background tabs.`,
      };
    }
    switch (action.tool) {
      case 'navigate': {
        await viewManager.loadURL(tabId, ensureScheme(action.url));
        const info = viewManager.listTabs().find((tab) => tab.id === tabId);
        return { ok: true, observation: `Navigated. URL=${info?.url ?? action.url} TITLE=${info?.title ?? ''}` };
      }
      case 'read_text': {
        const text = await readText(tabId, action.selector);
        return { ok: true, observation: text.length > 0 ? text : '(no visible text)' };
      }
      case 'click': {
        const point = await resolveSelectorPoint(tabId, action.selector);
        if (!point) return { ok: false, observation: `No element matched selector: ${action.selector}` };
        const sink = buildInputSink(tabId);
        if (!sink) return { ok: false, observation: 'Tab is not available.' };
        const input = createInput(sink);
        await input.moveAndClick(cursors.get(tabId) ?? ORIGIN, point);
        cursors.set(tabId, point);
        return { ok: true, observation: `Clicked ${action.selector}.` };
      }
      case 'type': {
        const point = await resolveSelectorPoint(tabId, action.selector);
        if (!point) return { ok: false, observation: `No field matched selector: ${action.selector}` };
        const sink = buildInputSink(tabId);
        if (!sink) return { ok: false, observation: 'Tab is not available.' };
        const input = createInput(sink);
        await input.moveAndClick(cursors.get(tabId) ?? ORIGIN, point);
        cursors.set(tabId, point);
        await input.typeText(action.text);
        return { ok: true, observation: `Typed ${action.text.length} char(s) into ${action.selector}.` };
      }
      case 'scroll': {
        const contents = viewManager.getWebContents(tabId);
        if (!contents) return { ok: false, observation: 'Tab is not available.' };
        const delta = (action.amount ?? 600) * (action.direction === 'up' ? -1 : 1);
        await contents.executeJavaScript(`window.scrollBy({ top: ${delta}, behavior: 'instant' }); true`);
        return { ok: true, observation: `Scrolled ${action.direction} by ${Math.abs(delta)}px.` };
      }
      case 'screenshot': {
        if (!capture) return { ok: false, observation: 'Screenshot is not available in this build.' };
        const dataUrl = await capture(tabId);
        if (!dataUrl) return { ok: false, observation: 'Could not capture the page.' };
        return { ok: true, observation: 'Captured a screenshot of the page (attached as an image).', image: dataUrl };
      }
      case 'go_back': {
        const ok = viewManager.goBack(tabId);
        return { ok, observation: ok ? 'Navigated back.' : 'Cannot go back (no earlier history).' };
      }
      case 'go_forward': {
        const ok = viewManager.goForward(tabId);
        return { ok, observation: ok ? 'Navigated forward.' : 'Cannot go forward (no later history).' };
      }
      case 'reload': {
        viewManager.reload(tabId);
        return { ok: true, observation: 'Reloaded the page.' };
      }
      case 'wait_for': {
        const contents = viewManager.getWebContents(tabId);
        if (!contents) return { ok: false, observation: 'Tab is not available.' };
        const timeout = Math.min(30_000, Math.max(0, action.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS));
        const deadline = Date.now() + timeout;
        const probe = `Boolean(document.querySelector(${JSON.stringify(action.selector)}))`;
        for (;;) {
          const found = await contents.executeJavaScript(
            `(() => { try { return ${probe}; } catch { return false; } })()`
          );
          if (found === true) return { ok: true, observation: `Element appeared: ${action.selector}` };
          if (Date.now() >= deadline) return { ok: false, observation: `Timed out waiting for: ${action.selector}` };
          await sleep(DEFAULT_WAIT_INTERVAL_MS);
        }
      }
      case 'press_key': {
        const sink = buildInputSink(tabId);
        if (!sink) return { ok: false, observation: 'Tab is not available.' };
        const contents = viewManager.getWebContents(tabId);
        if (!contents) return { ok: false, observation: 'Tab is not available.' };
        // keyDown + char + keyUp so both key handlers and text inputs react.
        const code = normalizeKeyCode(action.key);
        contents.sendInputEvent({ type: 'keyDown', keyCode: code });
        if (code.length === 1) contents.sendInputEvent({ type: 'char', keyCode: code });
        contents.sendInputEvent({ type: 'keyUp', keyCode: code });
        return { ok: true, observation: `Pressed ${action.key}.` };
      }
      case 'remember': {
        if (!memory) return { ok: false, observation: 'Memory is not available in this build.' };
        const info = viewManager.listTabs().find((tab) => tab.id === tabId);
        const host = hostOfUrl(info?.url ?? '');
        if (!host) return { ok: false, observation: 'No current site to attach the note to.' };
        await memory.addSiteNote(host, action.note);
        return { ok: true, observation: `Saved a note for ${host}.` };
      }
      case 'video_transcript': {
        const result = await extractTranscript(tabId);
        if (result.text.length > 0) {
          return { ok: true, observation: truncate(result.text, MAX_OBSERVATION_CHARS) };
        }
        return {
          ok: false,
          observation: `No usable captions extracted (reason: ${result.reason}). For music or videos without captions, use research to find the lyrics/text, or analyze_audio to describe the sound.`,
        };
      }
      case 'analyze_audio': {
        const contents = viewManager.getWebContents(tabId);
        if (!contents) return { ok: false, observation: 'Tab is not available.' };
        const raw = await contents.executeJavaScript(ANALYZE_AUDIO_SCRIPT);
        const text = typeof raw === 'string' ? raw.trim() : '';
        return text.length > 0
          ? { ok: true, observation: text }
          : {
              ok: false,
              observation:
                'Could not analyze the audio (no playing media element found, or the browser blocked audio capture).',
            };
      }
      case 'research': {
        // Hidden background research: open an off-screen tab, read it, close it —
        // WITHOUT touching the tab the user is watching (criterion: no surprise navigation).
        const target = action.url
          ? ensureScheme(action.url)
          : action.query
            ? `https://www.google.com/search?q=${encodeURIComponent(action.query)}`
            : '';
        if (!target) return { ok: false, observation: 'Provide a query or url to research.' };
        let hiddenId: BrowserTabId | undefined;
        try {
          hiddenId = viewManager.createTab({ visible: false, bounds: HIDDEN_TAB_BOUNDS });
          await viewManager.loadURL(hiddenId, target);
          await sleep(1200); // let the page settle
          const text = await readText(hiddenId);
          const trimmed = (text ?? '').trim();
          if (trimmed.length === 0)
            return { ok: false, observation: `Opened ${target} in the background but found no readable text.` };
          return {
            ok: true,
            observation: `Researched ${target} (background):\n${truncate(trimmed, MAX_OBSERVATION_CHARS)}`,
          };
        } catch (error) {
          return {
            ok: false,
            observation: `Background research failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        } finally {
          if (hiddenId) viewManager.destroyTab(hiddenId);
        }
      }
      case 'summarize': {
        if (!summarizer) return { ok: false, observation: 'Summarize is not available in this build.' };
        // Prefer readability (main article body) over raw innerText so nav/ads/
        // footers don't pollute the summary; fall back to readText when needed.
        let title = '';
        let body = '';
        if (readMainContent) {
          try {
            const main = await readMainContent(tabId);
            title = main.title;
            body = main.text;
          } catch {
            body = '';
          }
        }
        if (body.trim().length === 0) {
          body = await readText(tabId, action.selector);
        }
        if (body.trim().length === 0) {
          return { ok: false, observation: 'No readable content found on the page to summarize.' };
        }
        const { summary, chunks } = await summarizer.summarize(body, { model, signal });
        if (summary.trim().length === 0) {
          return { ok: false, observation: 'The summarizer returned an empty result.' };
        }
        const header = title ? `Summary of "${title}" (${chunks} section(s)):\n` : `Summary (${chunks} section(s)):\n`;
        return { ok: true, observation: truncate(header + summary, MAX_OBSERVATION_CHARS) };
      }
      case 'deep_research': {
        if (!deepResearch) {
          // Graceful fallback: a single background research pass.
          const target = `https://www.google.com/search?q=${encodeURIComponent(action.query)}`;
          let hiddenId: BrowserTabId | undefined;
          try {
            hiddenId = viewManager.createTab({ visible: false, bounds: HIDDEN_TAB_BOUNDS });
            await viewManager.loadURL(hiddenId, target);
            await sleep(1200);
            const text = (await readText(hiddenId)).trim();
            return text.length > 0
              ? {
                  ok: true,
                  observation: `Deep research is unavailable; shallow result for "${action.query}":\n${truncate(text, MAX_OBSERVATION_CHARS)}`,
                }
              : { ok: false, observation: 'Deep research is unavailable and the fallback search found nothing.' };
          } catch (error) {
            return {
              ok: false,
              observation: `Research failed: ${error instanceof Error ? error.message : String(error)}`,
            };
          } finally {
            if (hiddenId) viewManager.destroyTab(hiddenId);
          }
        }
        const { answer, sources } = await deepResearch.research(action.query, { model, signal });
        if (answer.trim().length === 0) {
          return { ok: false, observation: `Deep research found no usable sources for "${action.query}".` };
        }
        const refs =
          sources.length > 0
            ? '\n\nSources:\n' + sources.map((s) => `[${s.index}] ${s.title} — ${s.url}`).join('\n')
            : '';
        return { ok: true, observation: truncate(answer + refs, MAX_OBSERVATION_CHARS) };
      }
      case 'finish':
        return { ok: true, observation: action.answer };
    }
  };

  const run = async (request: RunAgentRequest, onEvent: AgentEventSink): Promise<RunAgentResult> => {
    const { tabId, model, instruction } = request;
    const interactive = request.interactive ?? false;

    const controller = new AbortController();
    cancellations.set(tabId, controller);

    // Build the running message list: system + prior history + this instruction.
    // The system prompt is augmented with the user's persona and any saved notes
    // for the current site (personal-agent memory), when a memory store is wired.
    let systemPrompt = SYSTEM_PROMPT;
    // Mode directive: invisible by default, interactive only when the user grants it.
    systemPrompt += interactive
      ? '\n\n## Control mode: INTERACTIVE (granted)\nThe user has granted control of the visible tab this turn. You MAY navigate / click / type / scroll / press_key / go_back / go_forward / reload to carry out the task. Still prefer reading and hidden-tab research when they suffice; only act on the visible page when the task needs it.'
      : '\n\n## Control mode: INVISIBLE (default)\nThe user has NOT granted control of the visible tab. You MUST stay invisible: only read/scrape the current page (read_text, summarize, video_transcript) and use hidden background tabs (research, deep_research). The interactive tools (navigate, click, type, scroll, press_key, go_back, go_forward, reload) are DISABLED and will be refused — do not call them; achieve the goal another way or finish explaining what you found.';
    if (memory) {
      try {
        const persona = (await memory.getPersona()).trim();
        if (persona.length > 0) {
          systemPrompt += `\n\n## User persona / standing instructions\n${persona}`;
        }
        const info = viewManager.listTabs().find((tab) => tab.id === tabId);
        const host = hostOfUrl(info?.url ?? '');
        if (host) {
          const notes = await memory.getSiteNotes(host);
          if (notes.length > 0) {
            const recent = notes
              .slice(-8)
              .map((n) => `- ${n.text}`)
              .join('\n');
            systemPrompt += `\n\n## What you remember about ${host}\n${recent}`;
          }
        }
      } catch {
        // Memory is best-effort; never block a turn on a memory read failure.
      }
    }

    const messages: Array<{ role: string; content: ChatContent }> = [{ role: 'system', content: systemPrompt }];
    for (const turn of request.history ?? []) {
      messages.push({ role: turn.role, content: turn.content });
    }
    // Ground the model in WHERE it currently is. Without this the agent is blind
    // to the page the user is watching, and when asked to act on "this video/page"
    // it invents URLs (e.g. an empty `watch?v=`) instead of using the real one.
    const current = viewManager.listTabs().find((tab) => tab.id === tabId);
    const currentUrl = current?.url ?? '';
    if (currentUrl.length > 0) {
      messages.push({
        role: 'user',
        content: `Context — the tab is currently on: URL=${currentUrl} TITLE=${current?.title ?? ''}. When the user refers to "this page/video", act on THIS url; do not invent another.`,
      });
    }
    messages.push({ role: 'user', content: instruction });

    // ---- One-shot FAST PATH for "summarize this video/page" -----------------
    // Comet/Gemini are fast because they do NOT run a multi-step agent loop for a
    // summary: they grab the transcript/content once and make a SINGLE model
    // call. We do the same when the instruction is clearly a summary request and
    // a summarizer is wired — skipping the ReAct round-trips entirely.
    const wantsSummary = SUMMARY_INTENT_RE.test(instruction);
    if (wantsSummary && summarizer && !controller.signal.aborted) {
      const host = hostOfUrl(currentUrl);
      const isYouTube = /(?:^|\.)youtube\.com$|(?:^|\.)youtu\.be$/.test(host);
      try {
        let source = '';
        let label = '';
        if (isYouTube) {
          onEvent({ type: 'action', tabId, tool: 'video_transcript', summary: 'video_transcript()' });
          const tr = await extractTranscript(tabId);
          onEvent({
            type: 'observation',
            tabId,
            tool: 'video_transcript',
            ok: tr.text.length > 0,
            summary: tr.text.length > 0 ? truncate(tr.text, MAX_UI_SUMMARY_CHARS) : `no captions: ${tr.reason}`,
          });
          source = tr.text;
          label = current?.title ?? '';
        } else if (readMainContent) {
          onEvent({ type: 'action', tabId, tool: 'summarize', summary: 'summarize()' });
          const main = await readMainContent(tabId).catch(() => ({ title: '', text: '' }));
          source = main.text;
          label = main.title;
        }
        if (source.trim().length > 0 && !controller.signal.aborted) {
          const { summary } = await summarizer.summarize(source, {
            model,
            focus: instruction,
            signal: controller.signal,
          });
          if (summary.trim().length > 0) {
            const answer = label ? `## ${label}\n\n${summary}` : summary;
            onEvent({ type: 'final', tabId, text: answer });
            return { answer, status: 'done', steps: 1 };
          }
        }
        // No source (e.g. video without captions) → fall through to the agent
        // loop, which can try research/analyze_audio.
      } catch {
        // Fast path is best-effort; fall back to the normal loop on any error.
      }
      if (controller.signal.aborted) {
        onEvent({ type: 'stopped', tabId });
        return { answer: '', status: 'stopped', steps: 0 };
      }
    }
    // -------------------------------------------------------------------------

    let steps = 0;
    try {
      while (steps < maxSteps) {
        if (controller.signal.aborted) {
          onEvent({ type: 'stopped', tabId });
          return { answer: '', status: 'stopped', steps };
        }

        let reply: string;
        try {
          reply = await chat({ model, messages, signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted) {
            onEvent({ type: 'stopped', tabId });
            return { answer: '', status: 'stopped', steps };
          }
          const message = error instanceof Error ? error.message : String(error);
          onEvent({ type: 'error', tabId, message });
          return { answer: '', status: 'error', steps };
        }

        const action = parseAction(reply);
        if (!action) {
          // The model answered in prose without a tool call — treat as the final answer.
          onEvent({ type: 'final', tabId, text: reply.trim() });
          return { answer: reply.trim(), status: 'done', steps };
        }

        if (action.tool === 'finish') {
          onEvent({ type: 'final', tabId, text: action.answer });
          return { answer: action.answer, status: 'done', steps };
        }

        const { summary, detail } = actionSummary(action);
        onEvent({ type: 'action', tabId, tool: action.tool, summary, detail });
        messages.push({ role: 'assistant', content: reply });

        let result: { ok: boolean; observation: string; image?: string };
        try {
          result = await executeAction(tabId, action, model, controller.signal, interactive);
        } catch (error) {
          result = { ok: false, observation: error instanceof Error ? error.message : String(error) };
        }

        onEvent({
          type: 'observation',
          tabId,
          tool: action.tool,
          ok: result.ok,
          summary: truncate(result.observation, MAX_UI_SUMMARY_CHARS),
        });
        if (result.image) {
          // Vision step: feed the captured page image alongside the text note so
          // the model can "see" the page on its next turn (OpenAI image_url part).
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: `Observation (${action.tool}): ${result.observation}` },
              { type: 'image_url', image_url: { url: result.image } },
            ],
          });
        } else {
          messages.push({
            role: 'user',
            content: `Observation (${action.tool}): ${truncate(result.observation, MAX_OBSERVATION_CHARS)}`,
          });
        }

        steps += 1;
        await sleep(0);
      }

      // Out of steps — ask for a wrap-up answer rather than leaving the user hanging.
      onEvent({ type: 'error', tabId, message: 'Reached the step limit before finishing.' });
      return { answer: '', status: 'max-steps', steps };
    } finally {
      cancellations.delete(tabId);
    }
  };

  const cancel = (tabId: BrowserTabId): void => {
    cancellations.get(tabId)?.abort();
  };

  return { run, cancel };
};
