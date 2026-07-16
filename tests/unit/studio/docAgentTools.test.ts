/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the Studio document-agent tool layer: action parsing, JSON
 * extraction from model replies, and the tool dispatcher's guardrails.
 */

import { describe, expect, it, vi } from 'vitest';

// Mock the renderer-bound connector so runTool can be exercised in node.
vi.mock('@renderer/pages/editor/adapters/onlyOfficeConnector', () => ({
  readText: vi.fn(async () => 'hello world'),
  replaceAllText: vi.fn(async () => undefined),
  searchReplace: vi.fn(async () => undefined),
  insertText: vi.fn(async () => undefined),
  insertHtml: vi.fn(async () => undefined),
  appendText: vi.fn(async () => undefined),
  runOfficeScript: vi.fn(async () => 'script-result'),
}));

import { insertHtml, replaceAllText, runOfficeScript } from '@renderer/pages/editor/adapters/onlyOfficeConnector';
import { TOOL_GUIDE, extractActionJson, parseAction, runTool } from '@/renderer/pages/studio/docAgentTools';

describe('TOOL_GUIDE', () => {
  it('frames Office API as the premium PPTX path for visual deck work', () => {
    expect(TOOL_GUIDE).toContain('create_premium_doc');
    expect(TOOL_GUIDE).toContain('create_premium_deck');
    expect(TOOL_GUIDE).toContain('review_premium_quality');
    expect(TOOL_GUIDE).toContain('For premium PPTX work');
    expect(TOOL_GUIDE).toContain('place shapes/images');
    expect(TOOL_GUIDE).toContain('transitions/effects when supported');
  });
});

describe('parseAction', () => {
  it('accepts each valid tool shape', () => {
    expect(parseAction({ tool: 'read_document' })).toEqual({ tool: 'read_document' });
    expect(parseAction({ tool: 'replace_all', text: 'x' })).toEqual({ tool: 'replace_all', text: 'x' });
    expect(parseAction({ tool: 'search_replace', search: 'a', replace: 'b' })).toEqual({
      tool: 'search_replace',
      search: 'a',
      replace: 'b',
    });
    expect(parseAction({ tool: 'insert_text', text: 't' })).toEqual({ tool: 'insert_text', text: 't' });
    expect(parseAction({ tool: 'append_text', text: 't' })).toEqual({ tool: 'append_text', text: 't' });
    expect(parseAction({ tool: 'finish', summary: 's' })).toEqual({ tool: 'finish', summary: 's' });
  });

  it('rejects malformed or unknown actions', () => {
    expect(parseAction(null)).toBeNull();
    expect(parseAction({})).toBeNull();
    expect(parseAction({ tool: 'replace_all' })).toBeNull(); // missing text
    expect(parseAction({ tool: 'search_replace', search: 'a' })).toBeNull(); // missing replace
    expect(parseAction({ tool: 'nope' })).toBeNull();
  });

  it('normalizes a premium doc plan for rich DOCX generation', () => {
    const action = parseAction({
      tool: 'create_premium_doc',
      plan: {
        title: ' Executive brief ',
        theme: { primary: '0f62fe', background: 'bad-color' },
        sections: [
          {
            heading: 'Opportunity',
            body: ['Market is ready'],
            bullets: ['Fast adoption', 'Clear buyer'],
            callout: 'Prioritize enterprise segment',
            table: { headers: ['Metric', 'Value'], rows: [['Pipeline', '$2M']] },
          },
        ],
      },
    });

    expect(action).toMatchObject({
      tool: 'create_premium_doc',
      plan: {
        title: 'Executive brief',
        theme: { primary: '#0F62FE', background: '#F7F8FA' },
        sections: [
          {
            heading: 'Opportunity',
            body: ['Market is ready'],
            bullets: ['Fast adoption', 'Clear buyer'],
            callout: 'Prioritize enterprise segment',
            table: { headers: ['Metric', 'Value'], rows: [['Pipeline', '$2M']] },
          },
        ],
      },
    });
  });

  it('rejects malformed premium doc plans', () => {
    expect(parseAction({ tool: 'create_premium_doc', plan: { title: '', sections: [] } })).toBeNull();
    expect(
      parseAction({ tool: 'create_premium_doc', plan: { title: 'x', sections: [{ body: ['missing heading'] }] } })
    ).toBeNull();
  });

  it('normalizes a premium deck plan for slide generation', () => {
    const action = parseAction({
      tool: 'create_premium_deck',
      plan: {
        title: ' Market launch ',
        theme: { primary: 'ff5500', background: 'bad-color' },
        slides: [
          { title: 'Cover', subtitle: 'North star', layout: 'cover', imageUrl: 'https://example.com/hero.png' },
          { title: 'Momentum', bullets: ['Revenue up', 'Pipeline deep'], layout: 'chart', chartValues: [[25, 55, 90]] },
        ],
      },
    });

    expect(action).toMatchObject({
      tool: 'create_premium_deck',
      plan: {
        title: 'Market launch',
        theme: { primary: '#FF5500', background: '#F7F8FA' },
        slides: [
          { title: 'Cover', layout: 'cover', imageUrl: 'https://example.com/hero.png' },
          { title: 'Momentum', layout: 'chart', bullets: ['Revenue up', 'Pipeline deep'], chartValues: [[25, 55, 90]] },
        ],
      },
    });
  });

  it('rejects malformed premium deck plans', () => {
    expect(parseAction({ tool: 'create_premium_deck', plan: { title: '', slides: [] } })).toBeNull();
    expect(
      parseAction({ tool: 'create_premium_deck', plan: { title: 'x', slides: [{ subtitle: 'missing title' }] } })
    ).toBeNull();
  });

  it('accepts bounded Office API scripts and trims whitespace', () => {
    expect(
      parseAction({ tool: 'run_office_api', code: "  const doc = Api.GetDocument(); return doc ? 'ok' : 'missing';  " })
    ).toEqual({
      tool: 'run_office_api',
      code: "const doc = Api.GetDocument(); return doc ? 'ok' : 'missing';",
    });
    expect(
      parseAction({
        tool: 'run_office_api',
        code: 'const document = Api.GetDocument(); return document ? "ok" : "missing";',
      })
    ).toEqual({
      tool: 'run_office_api',
      code: 'const document = Api.GetDocument(); return document ? "ok" : "missing";',
    });
  });

  it('rejects Office API scripts that leave the document-builder boundary', () => {
    expect(parseAction({ tool: 'run_office_api', code: 'return fetch(https://example.com)' })).toBeNull();
    expect(parseAction({ tool: 'run_office_api', code: 'return window.localStorage.getItem(x)' })).toBeNull();
    expect(parseAction({ tool: 'run_office_api', code: 'return require(node:fs)' })).toBeNull();
    expect(parseAction({ tool: 'run_office_api', code: 'return ' + 'x'.repeat(8100) })).toBeNull();
  });
  it('defaults finish summary to empty string when absent', () => {
    expect(parseAction({ tool: 'finish' })).toEqual({ tool: 'finish', summary: '' });
  });
});

describe('extractActionJson', () => {
  it('extracts a bare JSON object', () => {
    expect(extractActionJson('{"tool":"read_document"}')).toEqual({ tool: 'read_document' });
  });

  it('extracts from a fenced ```json block', () => {
    const reply = 'Sure!\n```json\n{"tool":"insert_text","text":"hi"}\n```\n';
    expect(extractActionJson(reply)).toEqual({ tool: 'insert_text', text: 'hi' });
  });

  it('tolerates trailing prose after the object', () => {
    expect(extractActionJson('{"tool":"finish","summary":"ok"} done')).toEqual({ tool: 'finish', summary: 'ok' });
  });

  it('returns null when no JSON is present', () => {
    expect(extractActionJson('no json here')).toBeNull();
  });
});

describe('runTool', () => {
  it('finishes the loop on finish', async () => {
    const r = await runTool('/f.docx', 'word', { tool: 'finish', summary: 'all done' });
    expect(r.done).toBe(true);
    expect(r.observation).toBe('all done');
  });

  it('reads document text', async () => {
    const r = await runTool('/f.docx', 'word', { tool: 'read_document' });
    expect(r.done).toBe(false);
    expect(r.observation).toContain('hello world');
  });

  it('blocks tools not allowed for the document kind', async () => {
    // replace_all is Word-only; reject for a spreadsheet.
    const r = await runTool('/f.xlsx', 'cell', { tool: 'replace_all', text: 'x' });
    expect(r.done).toBe(false);
    expect(r.observation).toMatch(/not available/i);
  });

  it('runs an allowed write tool', async () => {
    const r = await runTool('/f.docx', 'word', { tool: 'append_text', text: 'p' });
    expect(r.done).toBe(false);
    expect(r.observation).toMatch(/appended/i);
  });

  it('audits premium slide quality with live visual metadata', async () => {
    vi.mocked(runOfficeScript).mockResolvedValueOnce(
      JSON.stringify({ slideCount: 4, drawingCount: 16, textBoxCount: 9, imageLikeCount: 2, avgDrawingsPerSlide: 4 })
    );
    const r = await runTool('/deck.pptx', 'slide', { tool: 'review_premium_quality' });

    expect(r.done).toBe(false);
    expect(r.observation).toContain('Premium quality audit (slide)');
    expect(r.observation).toContain('Visual object summary');
    expect(r.observation).toContain('16 drawing object(s)');
    expect(runOfficeScript).toHaveBeenCalledWith('/deck.pptx', expect.stringContaining('GetAllDrawings'));
  });

  it('runs a bounded Office API script', async () => {
    vi.mocked(runOfficeScript).mockClear();
    const r = await runTool('/f.docx', 'word', { tool: 'run_office_api', code: ' return Api.GetDocument(); ' });
    expect(r.done).toBe(false);
    expect(r.observation).toContain('script-result');
    expect(runOfficeScript).toHaveBeenCalledWith('/f.docx', 'return Api.GetDocument();');
  });

  it('returns an error observation when an Office API script stalls', async () => {
    vi.useFakeTimers();
    vi.mocked(runOfficeScript).mockImplementationOnce(() => new Promise<string>(() => {}));

    try {
      const pending = runTool('/f.docx', 'word', { tool: 'run_office_api', code: 'return Api.GetDocument();' });
      await vi.advanceTimersByTimeAsync(12000);
      const r = await pending;

      expect(r.done).toBe(false);
      expect(r.observation).toMatch(/timed out after 12s/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects unsafe Office API scripts before they reach the connector', async () => {
    vi.mocked(runOfficeScript).mockClear();
    const r = await runTool('/f.docx', 'word', {
      tool: 'run_office_api',
      code: 'return fetch(https://example.com)',
    });
    expect(r.done).toBe(false);
    expect(r.observation).toMatch(/rejected/i);
    expect(runOfficeScript).not.toHaveBeenCalled();
  });
});
