/** Deterministic, page-side UI quality audit for Quick Test. */

import type { CdpWebContents } from './quickTestTracer';

export type UiAuditCategory = 'contrast' | 'typography' | 'accessibility' | 'layout' | 'interaction';
export type UiAuditSeverity = 'critical' | 'serious' | 'moderate' | 'minor';

export type UiAuditFinding = {
  ruleId: string;
  category: UiAuditCategory;
  severity: UiAuditSeverity;
  selector: string;
  detail: string;
  measured?: string;
  expected?: string;
  rect?: { x: number; y: number; width: number; height: number };
  sourceFile?: string;
  sourceLine?: number;
};

export type UiAuditReport = {
  score: number;
  auditedAt: number;
  url: string;
  elementCount: number;
  findings: UiAuditFinding[];
  categoryScores: Record<UiAuditCategory, number>;
  metrics?: {
    visibleElementCount: number;
    textElementCount: number;
    interactiveElementCount: number;
    fontFamilyCount: number;
    fontSizeCount: number;
  };
  ruleCounts?: Record<string, number>;
  truncated?: boolean;
};

const UI_AUDIT_SCRIPT = `
(() => {
  const MAX_FINDINGS = 500;
  const allElements = Array.from(document.querySelectorAll('*'));
  const all = allElements.slice(0, 6000);
  const findings = [];
  const visible = (el) => {
    const s = getComputedStyle(el); const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 && r.width > 0 && r.height > 0;
  };
  const selector = (el) => {
    if (el.id) return el.tagName.toLowerCase() + '#' + String(el.id);
    const test = el.getAttribute('data-testid'); if (test) return '[data-testid="' + test.replace(/"/g, '\\"') + '"]';
    const name = el.getAttribute('name'); if (name) return el.tagName.toLowerCase() + '[name="' + name.replace(/"/g, '\\"') + '"]';
    const cls = Array.from(el.classList || []).slice(0, 2); return el.tagName.toLowerCase() + (cls.length ? '.' + cls.map(String).join('.') : '');
  };
  const source = (el) => {
    let node = el, hops = 0;
    while (node && hops++ < 8) {
      const key = Object.keys(node).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      let fiber = key ? node[key] : null; let depth = 0;
      while (fiber && depth++ < 25) {
        const src = fiber._debugSource;
        if (src && src.fileName) return { sourceFile: String(src.fileName), sourceLine: Number(src.lineNumber || 0) };
        fiber = fiber.return;
      }
      node = node.parentElement;
    }
    return {};
  };
  const add = (el, ruleId, category, severity, detail, measured, expected) => {
    if (findings.length >= MAX_FINDINGS) return;
    const r = el.getBoundingClientRect();
    findings.push({ ruleId, category, severity, selector: selector(el), detail, measured, expected,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height }, ...source(el) });
  };
  const rgba = (value) => {
    const m = String(value).match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(',').map(Number); return { r:p[0], g:p[1], b:p[2], a:p.length > 3 ? p[3] : 1 };
  };
  const background = (el) => { let n = el; while (n) { const c = rgba(getComputedStyle(n).backgroundColor); if (c && c.a > .05) return c; n = n.parentElement; } return {r:255,g:255,b:255,a:1}; };
  const lum = (c) => { const f = v => { v/=255; return v <= .03928 ? v/12.92 : Math.pow((v+.055)/1.055,2.4); }; return .2126*f(c.r)+.7152*f(c.g)+.0722*f(c.b); };
  const ratio = (a,b) => { const x=lum(a), y=lum(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
  const textNodes = all.filter(el =>
    visible(el) &&
    Array.from(el.childNodes).some((n) => {
      const text = n.textContent;
      return n.nodeType === 3 && Boolean(text && text.trim());
    })
  );
  const visibleElements = all.filter(visible);
  const fontFamilies = new Set(textNodes.map(el => getComputedStyle(el).fontFamily).filter(Boolean));
  const fontSizes = new Set(textNodes.map(el => Number.parseFloat(getComputedStyle(el).fontSize).toFixed(1)).filter(Boolean));
  textNodes.forEach(el => {
    const s=getComputedStyle(el), fg=rgba(s.color), bg=background(el), fs=parseFloat(s.fontSize), fw=parseInt(s.fontWeight)||400;
    if (fg && bg) { const cr=ratio(fg,bg), large=fs>=24 || (fs>=18.66 && fw>=700), min=large?3:4.5; if (cr < min) add(el,'contrast.minimum','contrast',cr<2?'serious':'moderate','Text contrast is below WCAG AA.',cr.toFixed(2)+':1',min+':1'); }
    if (fs < 12) add(el,'typography.minimum-size','typography','moderate','Rendered text is smaller than 12px.',fs.toFixed(1)+'px','>= 12px');
    const lh=parseFloat(s.lineHeight); if (Number.isFinite(lh) && lh/fs < 1.2) add(el,'typography.line-height','typography','moderate','Line height is too tight for reliable reading.',(lh/fs).toFixed(2),'>= 1.2');
  });
  visibleElements.forEach(el => {
    const r=el.getBoundingClientRect();
    if (r.right > window.innerWidth + 1 || r.left < -1) add(el,'layout.viewport-overflow','layout','serious','Element extends outside the horizontal viewport.',Math.round(r.left)+'..'+Math.round(r.right),'0..'+window.innerWidth);
  });
  const interactive = Array.from(document.querySelectorAll('button,a[href],input,select,textarea,[role="button"],[tabindex]')).filter(visible);
  interactive.forEach(el => {
    const r=el.getBoundingClientRect(); if (r.width < 24 || r.height < 24) add(el,'interaction.target-size','interaction','serious','Interactive target is smaller than WCAG 2.2 minimum.',Math.round(r.width)+'x'+Math.round(r.height)+'px','>= 24x24px');
    const name=(el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent||el.getAttribute('alt')||'').trim(); if (!name) add(el,'accessibility.name','accessibility','serious','Interactive element has no accessible name.','','Accessible name');
  });
  document.querySelectorAll('img').forEach(el => { if (!el.hasAttribute('alt')) add(el,'accessibility.image-alt','accessibility','serious','Image is missing an alt attribute.','','alt attribute'); });
  document.querySelectorAll('input,select,textarea').forEach(el => {
    const id=el.id; const labelled=el.hasAttribute('aria-label')||el.hasAttribute('aria-labelledby')||(id && Array.from(document.querySelectorAll('label')).some(label => label.htmlFor === id))||el.closest('label');
    if (!labelled) add(el,'accessibility.form-label','accessibility','serious','Form control has no programmatic label.','','label/aria-label');
  });
  const ids = new Map(); all.forEach(el => { if (el.id) { if (ids.has(el.id)) add(el,'accessibility.duplicate-id','accessibility','serious','Duplicate id breaks label and accessibility references.',el.id,'Unique id'); else ids.set(el.id,el); } });
  let lastHeading=0; document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(el => { const level=Number(el.tagName[1]); if (lastHeading && level>lastHeading+1) add(el,'accessibility.heading-order','accessibility','moderate','Heading level skips part of the hierarchy.','H'+lastHeading+' → H'+level,'No skipped level'); lastHeading=level; });
  if (!document.documentElement.lang.trim()) add(document.documentElement,'accessibility.document-language','accessibility','serious','Document language is not declared.','','html[lang]');
  if (!document.title.trim()) add(document.head || document.documentElement,'accessibility.page-title','accessibility','serious','Page has no descriptive title.','','Non-empty document title');
  if (fontFamilies.size > 4) add(document.documentElement,'typography.family-sprawl','typography','moderate','The page uses too many font families to maintain a coherent type system.',String(fontFamilies.size),'<= 4 font families');
  if (fontSizes.size > 12) add(document.documentElement,'typography.scale-sprawl','typography','minor','The page uses an unusually fragmented font-size scale.',String(fontSizes.size),'<= 12 font sizes');
  if (document.documentElement.scrollWidth > window.innerWidth + 1) add(document.documentElement,'layout.document-overflow','layout','serious','The document creates horizontal scrolling.',String(document.documentElement.scrollWidth)+'px','<= '+window.innerWidth+'px');
  const weights={critical:12,serious:7,moderate:3,minor:1};
  const categories=['contrast','typography','accessibility','layout','interaction'];
  const ruleCounts={}; findings.forEach(f => { ruleCounts[f.ruleId]=(ruleCounts[f.ruleId]||0)+1; });
  const categoryScores={}; categories.forEach(c => {
    const grouped={}; findings.filter(f=>f.category===c).forEach(f => {
      grouped[f.ruleId]=(grouped[f.ruleId]||0)+weights[f.severity];
    });
    const penalty=Object.values(grouped).reduce((n,value)=>n+Math.min(25,Number(value)),0);
    categoryScores[c]=Math.max(0,100-penalty);
  });
  const score=Math.round(categories.reduce((n,c)=>n+categoryScores[c],0)/categories.length);
  return { score, auditedAt:Date.now(), url:location.href, elementCount:allElements.length, findings, categoryScores,
    metrics: { visibleElementCount:visibleElements.length, textElementCount:textNodes.length,
      interactiveElementCount:interactive.length, fontFamilyCount:fontFamilies.size, fontSizeCount:fontSizes.size }, ruleCounts,
    truncated: allElements.length > all.length || findings.length >= MAX_FINDINGS };
})()
`;

export const runUiAudit = async (webContents: CdpWebContents): Promise<UiAuditReport> => {
  const result = await webContents.executeJavaScript(UI_AUDIT_SCRIPT);
  if (
    !result ||
    typeof result !== 'object' ||
    typeof (result as Partial<UiAuditReport>).score !== 'number' ||
    !Array.isArray((result as Partial<UiAuditReport>).findings) ||
    !(result as Partial<UiAuditReport>).categoryScores
  ) {
    throw new Error('UI audit did not return a valid report.');
  }
  return result as UiAuditReport;
};
