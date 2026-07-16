/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `docAgentTools` — the tool catalogue + dispatcher used to edit the *live*
 * ONLYOFFICE document via {@link onlyOfficeConnector}.
 *
 * The Office-editor MCP server (Main process) sends ONE action at a time over
 * the editor-tools bridge; the renderer provider
 * ({@link file://./editorToolsProvider.ts}) validates it with {@link parseAction}
 * and runs it with {@link runTool} against the live editor, returning a short
 * observation. Tools run locally inside the editor, and the Office API escape
 * hatch is timeout-guarded so a stalled editor command cannot hang the agent.
 *
 * Renderer-only.
 */

import {
  appendText,
  applyHeadings,
  formatPassage,
  formatText,
  insertHtml,
  insertTable,
  insertTableOfContents,
  insertText,
  readText,
  replaceAllText,
  replacePassage,
  runOfficeScript,
  searchReplace,
  setCells,
  type OfficeDocKind,
  type TextFormat,
} from '@renderer/pages/editor/adapters/onlyOfficeConnector';
import type { PreviewContentType } from '@/common/types/office/preview';
import { validateOfficeApiScript } from '@/common/types/office/officeApiScript';
import { emitter } from '@/renderer/utils/emitter';

export type PremiumDeckSlideLayout = 'cover' | 'section' | 'content' | 'split' | 'image' | 'chart' | 'quote';

export type PremiumDeckTheme = {
  primary: string;
  secondary: string;
  background: string;
  text: string;
  fontFamily: string;
};

export type PremiumDeckSlide = {
  title: string;
  subtitle?: string;
  bullets: string[];
  layout: PremiumDeckSlideLayout;
  imageUrl?: string;
  accentColor?: string;
  chartValues?: number[][];
};

export type PremiumDeckPlan = {
  title: string;
  subtitle?: string;
  theme: PremiumDeckTheme;
  slides: PremiumDeckSlide[];
};
export type PremiumDocTable = {
  headers: string[];
  rows: string[][];
};

export type PremiumDocSection = {
  heading: string;
  body: string[];
  bullets: string[];
  callout?: string;
  table?: PremiumDocTable;
  imageUrl?: string;
};

export type PremiumDocPlan = {
  title: string;
  subtitle?: string;
  theme: PremiumDeckTheme;
  sections: PremiumDocSection[];
};

export type PremiumSlideVisualSummary = {
  slideCount: number;
  drawingCount: number;
  textBoxCount: number;
  imageLikeCount: number;
  avgDrawingsPerSlide: number;
};

/** A single action the model may request. */
export type DocAgentAction =
  | { tool: 'read_document' }
  | { tool: 'replace_all'; text: string }
  | { tool: 'search_replace'; search: string; replace: string }
  | { tool: 'replace_passage'; find: string; replacement: string; until?: string }
  | { tool: 'insert_text'; text: string }
  | { tool: 'append_text'; text: string }
  | { tool: 'apply_headings'; headings: Array<{ text: string; level: number }> }
  | { tool: 'insert_toc'; atStart?: boolean }
  | { tool: 'format_text'; search: string; format: TextFormat }
  | { tool: 'format_passage'; find: string; format: TextFormat; until?: string }
  | { tool: 'insert_table'; rows: number; cols: number; data?: string[][] }
  | { tool: 'set_cells'; start: string; values: Array<Array<string | number>>; sheet?: string }
  | { tool: 'create_premium_doc'; plan: PremiumDocPlan }
  | { tool: 'create_premium_deck'; plan: PremiumDeckPlan }
  | { tool: 'review_premium_quality' }
  | { tool: 'open_visual_review' }
  | { tool: 'run_office_api'; code: string }
  | { tool: 'finish'; summary: string };

/** Result of executing one action. `done` ends the loop. */
export type ToolResult = { observation: string; done: boolean };

/** Human-readable tool list embedded in the system prompt (kept in sync with the union). */
export const TOOL_GUIDE = [
  'read_document — read the current document text. Args: none. Returns the text.',
  'replace_all — replace the WHOLE document with new text (Word only). Args: { "text": string }.',
  'search_replace — replace every occurrence of a string. Args: { "search": string, "replace": string }.',
  'replace_passage — replace ONE specific passage (Word only), the reliable way to edit a particular paragraph. Args: { "find": string, "replacement": string, "until"?: string }. With "find" alone it replaces the FIRST occurrence. With "find"+"until" it replaces everything from the start of "find" through the end of the first following "until" — pass the first few words as "find" and the last few words as "until" to target a long paragraph without quoting it all.',
  'insert_text — paste text at the cursor (replacing any selection). Args: { "text": string }.',
  'append_text — add a paragraph at the end (Word only). Args: { "text": string }.',
  'apply_headings — apply real heading styles (Heading 1–9) to paragraphs by exact text (Word only). Args: { "headings": [{ "text": string, "level": number }] }. Use this to mark section titles so a table of contents can pick them up.',
  'insert_toc — insert a real, auto-updating Table of Contents from the heading-styled paragraphs (Word only). Args: { "atStart": boolean }. Apply headings FIRST.',
  'format_text — apply character formatting to EVERY occurrence of a string (Word only). Args: { "search": string, "format": { "bold"?: boolean, "italic"?: boolean, "underline"?: boolean, "strikeout"?: boolean, "color"?: "#RRGGBB", "highlight"?: "#RRGGBB", "fontSize"?: number, "fontFamily"?: string } }.',
  'format_passage — format ONE specific passage (Word only) — like selecting the whole paragraph then applying bold/italic/etc. Args: { "find": string, "format": {…same as format_text…}, "until"?: string }. "find" alone targets the first occurrence; "find"+"until" covers everything from the start of "find" through the end of the first following "until" (pass first words as "find", last words as "until" for a long paragraph).',
  'insert_table — insert a table at the end (Word only). Args: { "rows": number, "cols": number, "data"?: string[][] }. When "data" is given it fills the cells and sets the size.',
  'set_cells — write a block of spreadsheet cells (Excel only). Args: { "start": "A1", "values": (string|number)[][], "sheet"?: string }. Values are written row-by-row from "start".',
  'create_premium_doc - build a polished DOCX from a structured plan. Args: { "plan": { "title": string, "subtitle"?: string, "theme"?: { "primary"?: "#RRGGBB", "secondary"?: "#RRGGBB", "background"?: "#RRGGBB", "text"?: "#RRGGBB", "fontFamily"?: string }, "sections": [{ "heading": string, "body"?: string[], "bullets"?: string[], "callout"?: string, "imageUrl"?: string, "table"?: { "headers": string[], "rows": string[][] } }] } }. Use for reports, proposals, briefs, SOPs and executive docs that need hierarchy, callouts, tables and image blocks rather than plain text.',

  'create_premium_deck - build a polished PPTX deck from a structured plan. Args: { "plan": { "title": string, "subtitle"?: string, "theme"?: { "primary"?: "#RRGGBB", "secondary"?: "#RRGGBB", "background"?: "#RRGGBB", "text"?: "#RRGGBB", "fontFamily"?: string }, "slides": [{ "title": string, "subtitle"?: string, "bullets"?: string[], "layout"?: "cover"|"section"|"content"|"split"|"image"|"chart"|"quote", "imageUrl"?: string, "accentColor"?: "#RRGGBB", "chartValues"?: number[][] }] } }. Use after planning the story and visual system; generate or attach image assets first when the deck needs hero visuals.',

  'review_premium_quality - audit the live DOCX/PPTX after creation or edits. Args: none. Returns score, strengths and required improvements; call before final response for premium deliverables.',
  'open_visual_review - open the current DOCX/PPTX/XLSX in the preview panel for visual QA. Args: none. Use after premium creation plus audit so the rendered Office preview is visible before final delivery.',
  'run_office_api - run ANY ONLYOFFICE Document Builder API script in the live editor. Args: { "code": string } where code is a JS body that uses the global `Api` and may `return` a JSON-serializable value. Word: `Api.GetDocument()`; Spreadsheet: `Api.GetActiveSheet()` / `Api.GetSheet(i)`; Presentation: `Api.GetPresentation()`. For premium PPTX work, use this for real slide structures: add slides, place shapes/images, build visual hierarchy, apply brand colors, create charts/diagrams, tune typography, and add transitions/effects when supported by ONLYOFFICE. Example (Word, insert a 2x2 table): "const d=Api.GetDocument(); const t=Api.CreateTable(2,2); d.Push(t); return \'ok\';". Scripts are capped and must stay within ONLYOFFICE Document Builder APIs: no network, browser globals, Node.js APIs, imports, eval, or Function. Prefer the specific tools above for common edits; use this for everything else (images, charts, page setup, find by style, etc.).',
  'finish — stop and report what you did. Args: { "summary": string }.',
].join('\n');

/** Tools available per document kind (others are rejected with guidance). */
const ALLOWED: Record<OfficeDocKind, ReadonlySet<string>> = {
  word: new Set([
    'read_document',
    'replace_all',
    'search_replace',
    'replace_passage',
    'insert_text',
    'append_text',
    'apply_headings',
    'insert_toc',
    'format_text',
    'format_passage',
    'insert_table',
    'create_premium_doc',
    'review_premium_quality',
    'run_office_api',
    'finish',
  ]),
  cell: new Set(['read_document', 'search_replace', 'insert_text', 'set_cells', 'run_office_api', 'finish']),
  slide: new Set([
    'read_document',
    'search_replace',
    'insert_text',
    'create_premium_deck',
    'review_premium_quality',
    'run_office_api',
    'finish',
  ]),
};

const OFFICE_API_SCRIPT_TIMEOUT_MS = 12000;

const withTimeout = <T>(label: string, promise: Promise<T>, timeoutMs = OFFICE_API_SCRIPT_TIMEOUT_MS): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });

const MAX_PREMIUM_DECK_SLIDES = 12;
const MAX_PREMIUM_DECK_BULLETS = 6;
const MAX_PREMIUM_DECK_JSON_CHARS = 5200;
const PREMIUM_DECK_LAYOUTS = new Set<PremiumDeckSlideLayout>([
  'cover',
  'section',
  'content',
  'split',
  'image',
  'chart',
  'quote',
]);

const DEFAULT_PREMIUM_DECK_THEME: PremiumDeckTheme = {
  primary: '#246BFD',
  secondary: '#10A37F',
  background: '#F7F8FA',
  text: '#121826',
  fontFamily: 'Aptos',
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const cleanText = (value: unknown, maxChars: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxChars) : undefined;
};

const cleanHex = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match ? '#' + match[1].toUpperCase() : fallback;
};

const cleanImageUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^(https?:\/\/|data:image\/)/i.test(trimmed) === false) return undefined;
  return trimmed.slice(0, 1200);
};

const cleanChartValues = (value: unknown): number[][] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const rows = value
    .slice(0, 4)
    .map((row) =>
      Array.isArray(row)
        ? row
            .slice(0, 8)
            .map((n) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null))
            .filter((n): n is number => n !== null)
        : []
    )
    .filter((row) => row.length > 0);
  return rows.length > 0 ? rows : undefined;
};

export const normalizePremiumDeckPlan = (value: unknown): PremiumDeckPlan | null => {
  if (!isRecord(value)) return null;
  const title = cleanText(value.title, 120);
  if (!title) return null;
  if (!Array.isArray(value.slides) || value.slides.length === 0) return null;

  const themeSource = isRecord(value.theme) ? value.theme : {};
  const theme: PremiumDeckTheme = {
    primary: cleanHex(themeSource.primary, DEFAULT_PREMIUM_DECK_THEME.primary),
    secondary: cleanHex(themeSource.secondary, DEFAULT_PREMIUM_DECK_THEME.secondary),
    background: cleanHex(themeSource.background, DEFAULT_PREMIUM_DECK_THEME.background),
    text: cleanHex(themeSource.text, DEFAULT_PREMIUM_DECK_THEME.text),
    fontFamily: cleanText(themeSource.fontFamily, 48) ?? DEFAULT_PREMIUM_DECK_THEME.fontFamily,
  };

  const slides = value.slides.slice(0, MAX_PREMIUM_DECK_SLIDES).flatMap((raw): PremiumDeckSlide[] => {
    if (!isRecord(raw)) return [];
    const slideTitle = cleanText(raw.title, 120);
    if (!slideTitle) return [];
    const rawLayout = typeof raw.layout === 'string' ? raw.layout : 'content';
    const layout = PREMIUM_DECK_LAYOUTS.has(rawLayout as PremiumDeckSlideLayout)
      ? (rawLayout as PremiumDeckSlideLayout)
      : 'content';
    const bullets = Array.isArray(raw.bullets)
      ? raw.bullets.flatMap((item) => {
          const bullet = cleanText(item, 150);
          return bullet ? [bullet] : [];
        })
      : [];
    return [
      {
        title: slideTitle,
        subtitle: cleanText(raw.subtitle, 180),
        bullets: bullets.slice(0, MAX_PREMIUM_DECK_BULLETS),
        layout,
        imageUrl: cleanImageUrl(raw.imageUrl),
        accentColor: cleanHex(raw.accentColor, theme.primary),
        chartValues: cleanChartValues(raw.chartValues),
      },
    ];
  });

  if (slides.length === 0) return null;
  const normalized: PremiumDeckPlan = { title, subtitle: cleanText(value.subtitle, 180), theme, slides };
  return JSON.stringify(normalized).length <= MAX_PREMIUM_DECK_JSON_CHARS ? normalized : null;
};

export const buildPremiumDeckScript = (plan: PremiumDeckPlan): string =>
  [
    'const plan = ' + JSON.stringify(plan) + ';',
    'const slideW = 12192000;',
    'const slideH = 6858000;',
    'const margin = 609600;',
    'const ApiRef = Api;',
    "function rgb(hex) { const fallback = '246BFD'; const raw = String(hex || fallback).replace('#', ''); const safe = /^[0-9a-fA-F]{6}$/.test(raw) ? raw : fallback; return ApiRef.RGB(parseInt(safe.slice(0, 2), 16), parseInt(safe.slice(2, 4), 16), parseInt(safe.slice(4, 6), 16)); }",
    'function solid(hex) { return ApiRef.CreateSolidFill(rgb(hex)); }',
    'function noFill() { return ApiRef.CreateNoFill(); }',
    'function stroke(hex, width) { return ApiRef.CreateStroke(width || 0, hex ? solid(hex) : noFill()); }',
    "function addBox(slide, x, y, w, h, fillHex, strokeHex) { const shape = ApiRef.CreateShape('rect', w, h, fillHex ? solid(fillHex) : noFill(), stroke(strokeHex, strokeHex ? 12700 : 0)); shape.SetPosition(x, y); slide.AddObject(shape); return shape; }",
    "function addText(slide, text, x, y, w, h, size, color, bold, align) { const shape = addBox(slide, x, y, w, h, null, null); const content = shape.GetDocContent(); if (content && typeof content.RemoveAllElements === 'function') content.RemoveAllElements(); const paragraph = ApiRef.CreateParagraph(); if (paragraph.SetJc) paragraph.SetJc(align || 'left'); if (paragraph.SetFontSize) paragraph.SetFontSize(size || 32); if (paragraph.SetColor) paragraph.SetColor(rgb(color || plan.theme.text)); if (paragraph.SetBold) paragraph.SetBold(Boolean(bold)); paragraph.AddText(String(text || '')); content.Push(paragraph); return shape; }",
    "function addBullets(slide, bullets, x, y, w, h) { const shape = addBox(slide, x, y, w, h, null, null); const content = shape.GetDocContent(); if (content && typeof content.RemoveAllElements === 'function') content.RemoveAllElements(); for (let i = 0; i < bullets.length; i++) { const paragraph = ApiRef.CreateParagraph(); if (paragraph.SetFontSize) paragraph.SetFontSize(24); if (paragraph.SetColor) paragraph.SetColor(rgb(plan.theme.text)); paragraph.AddText('- ' + bullets[i]); content.Push(paragraph); } return shape; }",
    'function addBars(slide, values, x, y, w, h, color) { const row = values && values[0] ? values[0] : [35, 55, 80]; const gap = 91440; const barW = Math.floor((w - gap * (row.length - 1)) / row.length); for (let i = 0; i < row.length; i++) { const barH = Math.max(152400, Math.floor(h * row[i] / 100)); addBox(slide, x + i * (barW + gap), y + h - barH, barW, barH, color, null); } }',
    'const presentation = ApiRef.GetPresentation();',
    'if (presentation.SetSizes) presentation.SetSizes(slideW, slideH);',
    "for (let i = 0; i < plan.slides.length; i++) { const spec = plan.slides[i]; const slide = i === 0 ? presentation.GetSlideByIndex(0) : ApiRef.CreateSlide(); if (i > 0) presentation.AddSlide(slide); if (slide.RemoveAllObjects) slide.RemoveAllObjects(); if (spec.imageUrl && (spec.layout === 'image' || spec.layout === 'cover')) { slide.SetBackground(ApiRef.CreateBlipFill(spec.imageUrl, 'stretch')); } else { slide.SetBackground(solid(i === 0 || spec.layout === 'section' ? spec.accentColor : plan.theme.background)); } const accent = spec.accentColor || plan.theme.primary; addBox(slide, 0, 0, 152400, slideH, accent, null); if (spec.layout === 'cover' || spec.layout === 'section') { addText(slide, spec.title, margin, 1828800, slideW - margin * 2, 914400, 44, i === 0 ? '#FFFFFF' : plan.theme.text, true, 'left'); if (spec.subtitle) addText(slide, spec.subtitle, margin, 2895600, slideW - margin * 2, 609600, 24, i === 0 ? '#FFFFFF' : plan.theme.text, false, 'left'); } else if (spec.layout === 'quote') { addText(slide, '\"' + spec.title + '\"', 1219200, 1676400, 9753600, 1371600, 38, plan.theme.text, true, 'center'); if (spec.subtitle) addText(slide, spec.subtitle, 1828800, 3352800, 8534400, 609600, 22, accent, false, 'center'); } else { addText(slide, spec.title, margin, 609600, 6705600, 609600, 34, plan.theme.text, true, 'left'); if (spec.subtitle) addText(slide, spec.subtitle, margin, 1219200, 6096000, 457200, 18, accent, false, 'left'); if (spec.layout === 'chart') addBars(slide, spec.chartValues, 7315200, 1981200, 3657600, 3048000, accent); if (spec.imageUrl && spec.layout !== 'image') addBox(slide, 7315200, 1524000, 3657600, 3048000, '#E8EEF9', accent); addBullets(slide, spec.bullets || [], margin, 1981200, spec.layout === 'split' || spec.layout === 'chart' ? 5791200 : 9753600, 3657600); } }",
    "return 'Created premium deck with ' + plan.slides.length + ' slides: ' + plan.title;",
  ].join('\n');

const MAX_PREMIUM_DOC_SECTIONS = 12;
const MAX_PREMIUM_DOC_PARAGRAPHS = 5;
const MAX_PREMIUM_DOC_BULLETS = 8;
const MAX_PREMIUM_DOC_TABLE_ROWS = 8;
const MAX_PREMIUM_DOC_JSON_CHARS = 7000;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const cleanStringArray = (value: unknown, maxItems: number, maxChars: number): string[] =>
  Array.isArray(value)
    ? value
        .flatMap((item) => {
          const text = cleanText(item, maxChars);
          return text ? [text] : [];
        })
        .slice(0, maxItems)
    : [];

const cleanDocTable = (value: unknown): PremiumDocTable | undefined => {
  if (!isRecord(value)) return undefined;
  const headers = cleanStringArray(value.headers, 6, 60);
  if (headers.length === 0 || !Array.isArray(value.rows)) return undefined;
  const rows = value.rows.slice(0, MAX_PREMIUM_DOC_TABLE_ROWS).flatMap((row): string[][] => {
    if (!Array.isArray(row)) return [];
    const cells = row.slice(0, headers.length).map((cell) => cleanText(cell, 100) ?? '');
    return [cells];
  });
  return rows.length > 0 ? { headers, rows } : undefined;
};

export const normalizePremiumDocPlan = (value: unknown): PremiumDocPlan | null => {
  if (!isRecord(value)) return null;
  const title = cleanText(value.title, 140);
  if (!title) return null;
  if (!Array.isArray(value.sections) || value.sections.length === 0) return null;

  const themeSource = isRecord(value.theme) ? value.theme : {};
  const theme: PremiumDeckTheme = {
    primary: cleanHex(themeSource.primary, DEFAULT_PREMIUM_DECK_THEME.primary),
    secondary: cleanHex(themeSource.secondary, DEFAULT_PREMIUM_DECK_THEME.secondary),
    background: cleanHex(themeSource.background, DEFAULT_PREMIUM_DECK_THEME.background),
    text: cleanHex(themeSource.text, DEFAULT_PREMIUM_DECK_THEME.text),
    fontFamily: cleanText(themeSource.fontFamily, 48) ?? DEFAULT_PREMIUM_DECK_THEME.fontFamily,
  };

  const sections = value.sections.slice(0, MAX_PREMIUM_DOC_SECTIONS).flatMap((raw): PremiumDocSection[] => {
    if (!isRecord(raw)) return [];
    const heading = cleanText(raw.heading, 120);
    if (!heading) return [];
    return [
      {
        heading,
        body: cleanStringArray(raw.body, MAX_PREMIUM_DOC_PARAGRAPHS, 500),
        bullets: cleanStringArray(raw.bullets, MAX_PREMIUM_DOC_BULLETS, 160),
        callout: cleanText(raw.callout, 260),
        table: cleanDocTable(raw.table),
        imageUrl: cleanImageUrl(raw.imageUrl),
      },
    ];
  });

  if (sections.length === 0) return null;
  const normalized: PremiumDocPlan = { title, subtitle: cleanText(value.subtitle, 180), theme, sections };
  return JSON.stringify(normalized).length <= MAX_PREMIUM_DOC_JSON_CHARS ? normalized : null;
};

export const buildPremiumDocHtml = (plan: PremiumDocPlan): string => {
  const theme = plan.theme;
  const styles = [
    'font-family:' + escapeHtml(theme.fontFamily) + ';color:' + theme.text + ';line-height:1.45;',
    'font-size:11.5pt;',
  ].join('');
  const html = [
    `<div style="${styles}">`,
    `<h1 style="font-size:30pt;line-height:1.08;margin:0 0 10px;color:${theme.primary};">${escapeHtml(plan.title)}</h1>`,
    plan.subtitle
      ? `<p style="font-size:15pt;margin:0 0 22px;color:${theme.text};">${escapeHtml(plan.subtitle)}</p>`
      : '',
    `<div style="height:4px;background:${theme.secondary};width:160px;margin:0 0 26px;"></div>`,
  ];
  for (const section of plan.sections) {
    html.push(
      `<h2 style="font-size:18pt;margin:24px 0 8px;color:${theme.primary};">${escapeHtml(section.heading)}</h2>`
    );
    for (const paragraph of section.body) html.push(`<p style="margin:8px 0;">${escapeHtml(paragraph)}</p>`);
    if (section.callout) {
      html.push(
        `<div style="border-left:4px solid ${theme.secondary};background:${theme.background};padding:10px 14px;margin:14px 0;font-weight:600;">${escapeHtml(section.callout)}</div>`
      );
    }
    if (section.imageUrl) {
      html.push(
        `<p><img src="${escapeHtml(section.imageUrl)}" style="max-width:100%;height:auto;border-radius:6px;" /></p>`
      );
    }
    if (section.bullets.length > 0) {
      html.push('<ul style="margin:8px 0 12px 22px;">');
      for (const bullet of section.bullets) html.push(`<li>${escapeHtml(bullet)}</li>`);
      html.push('</ul>');
    }
    if (section.table) {
      html.push('<table style="border-collapse:collapse;width:100%;margin:12px 0;">');
      html.push('<thead><tr>');
      for (const header of section.table.headers)
        html.push(
          `<th style="border:1px solid #D7DEE8;background:${theme.primary};color:#FFFFFF;padding:7px;text-align:left;">${escapeHtml(header)}</th>`
        );
      html.push('</tr></thead><tbody>');
      for (const row of section.table.rows) {
        html.push('<tr>');
        for (const cell of row) html.push(`<td style="border:1px solid #D7DEE8;padding:7px;">${escapeHtml(cell)}</td>`);
        html.push('</tr>');
      }
      html.push('</tbody></table>');
    }
  }
  html.push('</div>');
  return html.join('');
};

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

const parseSlideVisualSummary = (value: string): PremiumSlideVisualSummary | null => {
  try {
    const parsed = JSON.parse(value) as Partial<PremiumSlideVisualSummary>;
    const slideCount = typeof parsed.slideCount === 'number' ? parsed.slideCount : 0;
    const drawingCount = typeof parsed.drawingCount === 'number' ? parsed.drawingCount : 0;
    const textBoxCount = typeof parsed.textBoxCount === 'number' ? parsed.textBoxCount : 0;
    const imageLikeCount = typeof parsed.imageLikeCount === 'number' ? parsed.imageLikeCount : 0;
    const avgDrawingsPerSlide = typeof parsed.avgDrawingsPerSlide === 'number' ? parsed.avgDrawingsPerSlide : 0;
    return { slideCount, drawingCount, textBoxCount, imageLikeCount, avgDrawingsPerSlide };
  } catch {
    return null;
  }
};

const buildSlideVisualSummaryScript = (): string =>
  [
    'const pres = Api.GetPresentation();',
    'const slideCount = pres.GetSlidesCount();',
    'let drawingCount = 0;',
    'let textBoxCount = 0;',
    'let imageLikeCount = 0;',
    'for (let i = 0; i < slideCount; i++) {',
    '  const slide = pres.GetSlideByIndex(i);',
    '  const drawings = slide && slide.GetAllDrawings ? slide.GetAllDrawings() : [];',
    '  drawingCount += drawings.length;',
    '  for (let j = 0; j < drawings.length; j++) {',
    '    const drawing = drawings[j];',
    '    const content = drawing && drawing.GetContent ? drawing.GetContent() : null;',
    '    if (content) textBoxCount++;',
    '    const classType = drawing && drawing.GetClassType ? String(drawing.GetClassType()) : ";',
    '    if (/image|picture|graphic|chart|shape/i.test(classType) && !content) imageLikeCount++;',
    '  }',
    '}',
    'return JSON.stringify({ slideCount, drawingCount, textBoxCount, imageLikeCount, avgDrawingsPerSlide: slideCount ? drawingCount / slideCount : 0 });',
  ].join('\n');

export const reviewPremiumQuality = (
  kind: OfficeDocKind,
  text: string,
  visualSummary?: PremiumSlideVisualSummary | null
): string => {
  const issues: string[] = [];
  const strengths: string[] = [];
  let score = 100;
  const words = wordCount(text);

  if (kind === 'slide') {
    const slideCount = Math.max(1, visualSummary?.slideCount ?? (text.match(/--- Slide \d+ ---/g) ?? []).length);
    const wordsPerSlide = Math.round(words / slideCount);
    if (slideCount < 3) {
      issues.push('Deck is too short for a premium narrative; add cover, proof, and closing/CTA slides.');
      score -= 20;
    } else {
      strengths.push('Deck has a multi-slide narrative structure.');
    }
    if (wordsPerSlide > 70) {
      issues.push('Slides are text-heavy; reduce copy and move detail into speaker notes or visuals.');
      score -= 20;
    } else {
      strengths.push('Slide text density is presentation-friendly.');
    }
    if (visualSummary) {
      if (visualSummary.slideCount >= 3 && visualSummary.avgDrawingsPerSlide >= 3) {
        strengths.push('Deck has visible slide objects beyond plain text.');
      } else {
        issues.push('Slide canvas looks under-designed; add shapes, image blocks, charts, or diagram objects.');
        score -= 20;
      }
      if (visualSummary.imageLikeCount === 0) {
        issues.push('No image/chart-like visual objects detected; add at least one strong image, chart, or diagram.');
        score -= 15;
      }
    } else {
      issues.push('Could not inspect slide visual objects; run a visual/preview check before final delivery.');
      score -= 10;
    }
    if (/chart|metric|growth|revenue|pipeline|trend|score|%/i.test(text) === false) {
      issues.push('No clear quantitative proof or chart cue detected; add a metric/chart slide.');
      score -= 15;
    }
    if (/image|visual|diagram|map|workflow|architecture/i.test(text) === false) {
      issues.push(
        'No visual/diagram cue detected in text; add at least one strong visual slide or image-backed section.'
      );
      score -= 15;
    }
  } else if (kind === 'word') {
    const sectionLike = text.split(/\n+/).filter((line) => line.trim().length > 0 && line.trim().length < 90).length;
    if (words < 300) {
      issues.push('Document is too thin for a premium deliverable; add analysis, rationale, and next steps.');
      score -= 20;
    }
    if (sectionLike < 4) {
      issues.push('Not enough apparent structure; add executive summary, sections, callouts, and conclusion.');
      score -= 20;
    } else {
      strengths.push('Document appears to have multiple scannable sections.');
    }
    if (/table|metric|comparison|option|risk|impact|timeline/i.test(text) === false) {
      issues.push('No table/comparison/metric cue detected; add a decision table or quantified proof block.');
      score -= 15;
    }
    if (/recommend|next step|action|decision|priority/i.test(text) === false) {
      issues.push('No clear recommendation or next action detected; add an executive decision section.');
      score -= 15;
    }
  } else {
    issues.push('Premium audit currently covers DOCX and PPTX only.');
    score -= 30;
  }

  const finalScore = Math.max(0, Math.min(100, score));
  const next =
    issues.length > 0
      ? issues.map((issue) => '- ' + issue).join('\n')
      : '- Product passes the current premium structure and slide-object audit; do a visual render check next.';
  const good =
    strengths.length > 0
      ? strengths.map((strength) => '- ' + strength).join('\n')
      : '- No major strengths detected yet.';
  const visual =
    kind === 'slide' && visualSummary
      ? `\nVisual object summary:\n- ${visualSummary.slideCount} slide(s), ${visualSummary.drawingCount} drawing object(s), ${visualSummary.textBoxCount} text box(es), ${visualSummary.imageLikeCount} image/chart-like object(s).`
      : '';
  return `Premium quality audit (${kind}): ${finalScore}/100${visual}\nStrengths:\n${good}\nRequired improvements:\n${next}`;
};

/** Parse a {@link TextFormat} object from untrusted input (or null if invalid). */
const parseTextFormat = (value: unknown): TextFormat | null => {
  if (typeof value !== 'object' || value === null) return null;
  const f = value as Record<string, unknown>;
  const fmt: TextFormat = {};
  if (typeof f.bold === 'boolean') fmt.bold = f.bold;
  if (typeof f.italic === 'boolean') fmt.italic = f.italic;
  if (typeof f.underline === 'boolean') fmt.underline = f.underline;
  if (typeof f.strikeout === 'boolean') fmt.strikeout = f.strikeout;
  if (typeof f.color === 'string') fmt.color = f.color;
  if (typeof f.highlight === 'string') fmt.highlight = f.highlight;
  if (typeof f.fontSize === 'number') fmt.fontSize = f.fontSize;
  if (typeof f.fontFamily === 'string') fmt.fontFamily = f.fontFamily;
  return fmt;
};

/** Validate that `value` is a well-formed {@link DocAgentAction}. */
export const parseAction = (value: unknown): DocAgentAction | null => {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const tool = v.tool;
  switch (tool) {
    case 'read_document':
      return { tool };
    case 'replace_all':
      return typeof v.text === 'string' ? { tool, text: v.text } : null;
    case 'search_replace':
      return typeof v.search === 'string' && typeof v.replace === 'string'
        ? { tool, search: v.search, replace: v.replace }
        : null;
    case 'replace_passage':
      return typeof v.find === 'string' && v.find.length > 0 && typeof v.replacement === 'string'
        ? { tool, find: v.find, replacement: v.replacement, until: typeof v.until === 'string' ? v.until : undefined }
        : null;
    case 'insert_text':
      return typeof v.text === 'string' ? { tool, text: v.text } : null;
    case 'append_text':
      return typeof v.text === 'string' ? { tool, text: v.text } : null;
    case 'apply_headings': {
      if (!Array.isArray(v.headings)) return null;
      const headings: Array<{ text: string; level: number }> = [];
      for (const raw of v.headings) {
        if (typeof raw !== 'object' || raw === null) return null;
        const h = raw as Record<string, unknown>;
        const text = h.text;
        const level = h.level;
        if (typeof text !== 'string' || typeof level !== 'number') return null;
        // Clamp to valid Word heading levels.
        const lvl = Math.min(9, Math.max(1, Math.round(level)));
        headings.push({ text, level: lvl });
      }
      return headings.length > 0 ? { tool, headings } : null;
    }
    case 'insert_toc':
      return { tool, atStart: typeof v.atStart === 'boolean' ? v.atStart : true };
    case 'format_text': {
      if (typeof v.search !== 'string' || v.search.length === 0) return null;
      const fmt = parseTextFormat(v.format);
      return fmt ? { tool, search: v.search, format: fmt } : null;
    }
    case 'format_passage': {
      if (typeof v.find !== 'string' || v.find.length === 0) return null;
      const fmt = parseTextFormat(v.format);
      return fmt ? { tool, find: v.find, format: fmt, until: typeof v.until === 'string' ? v.until : undefined } : null;
    }
    case 'insert_table': {
      const rows = typeof v.rows === 'number' ? Math.round(v.rows) : 0;
      const cols = typeof v.cols === 'number' ? Math.round(v.cols) : 0;
      let data: string[][] | undefined;
      if (Array.isArray(v.data)) {
        const grid: string[][] = [];
        for (const row of v.data) {
          if (!Array.isArray(row)) return null;
          grid.push(row.map((c) => String(c)));
        }
        data = grid;
      }
      if ((rows < 1 || cols < 1) && !data) return null;
      return { tool, rows: Math.max(1, rows), cols: Math.max(1, cols), data };
    }
    case 'set_cells': {
      if (typeof v.start !== 'string' || v.start.length === 0) return null;
      if (!Array.isArray(v.values)) return null;
      const values: Array<Array<string | number>> = [];
      for (const row of v.values) {
        if (!Array.isArray(row)) return null;
        values.push(row.map((c) => (typeof c === 'number' ? c : String(c))));
      }
      if (values.length === 0) return null;
      return { tool, start: v.start, values, sheet: typeof v.sheet === 'string' ? v.sheet : undefined };
    }
    case 'create_premium_doc': {
      const plan = normalizePremiumDocPlan(v.plan);
      return plan ? { tool, plan } : null;
    }

    case 'create_premium_deck': {
      const plan = normalizePremiumDeckPlan(v.plan);
      return plan ? { tool, plan } : null;
    }
    case 'run_office_api':
      if (typeof v.code !== 'string') return null;
      const validation = validateOfficeApiScript(v.code);
      return validation.ok ? { tool, code: validation.code } : null;
    case 'finish':
      return { tool, summary: typeof v.summary === 'string' ? v.summary : '' };
    default:
      return null;
  }
};

/** How much document text to feed back per read (avoid oversized prompts). */
const MAX_READ_CHARS = 12000;

/**
 * Execute one validated action against the live editor for `filePath`.
 * Returns a short observation and whether the loop should stop.
 */
export const runTool = async (filePath: string, kind: OfficeDocKind, action: DocAgentAction): Promise<ToolResult> => {
  if (action.tool === 'finish') {
    return { observation: action.summary || 'Done.', done: true };
  }
  if (!ALLOWED[kind].has(action.tool)) {
    return {
      observation: `Tool "${action.tool}" is not available for this ${kind} document. Allowed: ${[...ALLOWED[kind]].join(', ')}.`,
      done: false,
    };
  }
  try {
    switch (action.tool) {
      case 'read_document': {
        const text = await readText(filePath);
        const clipped = text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n…(truncated)` : text;
        return { observation: `Document text:\n${clipped}`, done: false };
      }
      case 'replace_all':
        await replaceAllText(filePath, action.text);
        return { observation: 'Replaced the whole document.', done: false };
      case 'search_replace':
        await searchReplace(filePath, action.search, action.replace);
        return { observation: `Replaced "${action.search}" with "${action.replace}".`, done: false };
      case 'replace_passage': {
        const ok = await replacePassage(filePath, action.find, action.replacement, action.until);
        return {
          observation: ok
            ? `Replaced the passage starting "${action.find.slice(0, 40)}".`
            : `Could not locate the passage starting "${action.find.slice(0, 40)}". Read the document and use the exact text.`,
          done: false,
        };
      }
      case 'insert_text':
        await insertText(filePath, action.text);
        return { observation: 'Inserted text at the cursor.', done: false };
      case 'append_text':
        await appendText(filePath, action.text);
        return { observation: 'Appended a paragraph at the end.', done: false };
      case 'apply_headings': {
        const applied = await applyHeadings(filePath, action.headings);
        return {
          observation:
            applied > 0
              ? `Applied heading styles to ${applied} of ${action.headings.length} paragraph(s).`
              : 'No paragraphs matched the given heading texts (check they match the document text exactly).',
          done: false,
        };
      }
      case 'insert_toc':
        await insertTableOfContents(filePath, action.atStart ?? true);
        return { observation: 'Inserted an automatic table of contents.', done: false };
      case 'format_text': {
        const n = await formatText(filePath, action.search, action.format);
        return {
          observation:
            n > 0
              ? `Formatted ${n} occurrence(s) of "${action.search}".`
              : `No occurrences of "${action.search}" were found to format.`,
          done: false,
        };
      }
      case 'format_passage': {
        const ok = await formatPassage(filePath, action.find, action.format, action.until);
        return {
          observation: ok
            ? `Formatted the passage starting "${action.find.slice(0, 40)}".`
            : `Could not locate the passage starting "${action.find.slice(0, 40)}". Read the document and use the exact text.`,
          done: false,
        };
      }
      case 'insert_table':
        await insertTable(filePath, action.rows, action.cols, action.data);
        return { observation: `Inserted a ${action.rows}×${action.cols} table.`, done: false };
      case 'set_cells': {
        const n = await setCells(filePath, action.start, action.values, action.sheet);
        return { observation: `Wrote ${n} cell(s) starting at ${action.start}.`, done: false };
      }
      case 'create_premium_doc': {
        const html = buildPremiumDocHtml(action.plan);
        await replaceAllText(filePath, '');
        await insertHtml(filePath, html);
        return { observation: `Created premium document with ${action.plan.sections.length} section(s).`, done: false };
      }

      case 'create_premium_deck': {
        const script = buildPremiumDeckScript(action.plan);
        const result = await withTimeout('Premium deck generation', runOfficeScript(filePath, script));
        return {
          observation:
            result.length > 0 ? result.slice(0, 500) : `Created premium deck with ${action.plan.slides.length} slides.`,
          done: false,
        };
      }

      case 'review_premium_quality': {
        const text = await readText(filePath);
        let visualSummary: PremiumSlideVisualSummary | null = null;
        if (kind === 'slide') {
          try {
            visualSummary = parseSlideVisualSummary(
              await withTimeout('Slide visual audit', runOfficeScript(filePath, buildSlideVisualSummaryScript()))
            );
          } catch {
            visualSummary = null;
          }
        }
        return { observation: reviewPremiumQuality(kind, text, visualSummary), done: false };
      }

      case 'run_office_api': {
        const validation = validateOfficeApiScript(action.code);
        if (validation.ok === false) {
          return { observation: `Office API script rejected: ${validation.reason}.`, done: false };
        }
        const result = await withTimeout('Office API script', runOfficeScript(filePath, validation.code));
        return {
          observation: result.length > 0 ? `Office API ran. Result: ${result.slice(0, 500)}` : 'Office API ran.',
          done: false,
        };
      }
      default:
        return { observation: 'Unknown tool.', done: false };
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { observation: `Tool error: ${message}`, done: false };
  }
};

/** Extract the first JSON object from a model reply (handles fenced blocks). */
export const extractActionJson = (reply: string): unknown => {
  // Prefer a ```json fenced block; else the first balanced {...}.
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : reply;
  const start = candidate.indexOf('{');
  if (start === -1) return null;
  // Walk to the matching closing brace to tolerate trailing prose.
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};
