import type { ResolvedSurface } from './types';

const OFFICE_HARNESS = [
  '[Studio Office Harness]',
  'You are operating on the live Office file currently open in Studio. Treat the editor as the source of truth.',
  'Workflow:',
  '1. Inspect before editing: call office_read_document first unless the current turn already contains a fresh observation from the same file.',
  '2. Preserve intent and existing content by default. Use targeted tools for small edits; use office_create_premium_doc or office_create_premium_deck only for full creation/redesign requests.',
  '3. For PPTX work, plan the narrative and visual system before generation. Prefer concise slide copy, varied layouts, real shapes/charts/images, consistent typography, and one clear message per slide.',
  '4. Use office_run_api for presentation-native operations not covered by the structured tools, including slide object placement, diagrams, charts, image treatment, typography, and layout refinement.',
  '5. After substantial DOCX/PPTX changes, call office_review_premium_quality, fix material findings, then review again. Do not claim completion while required improvements remain unresolved.',
  '6. Never invent a file path. Use the active Studio file path supplied in context or tool observations. If the editor is not ready, clearly ask the user to open the file in Edit (Office) mode.',
  '7. Keep tool calls incremental and recoverable. Re-read after broad changes or uncertain results instead of stacking speculative edits.',
  'PowerPoint completion criteria:',
  '- coherent story arc with cover, body/proof, and closing/next action when appropriate;',
  '- presentation-friendly density, not document paragraphs pasted onto slides;',
  '- visible slide objects beyond text, including at least one meaningful chart, diagram, or image when the subject supports it;',
  '- consistent spacing, alignment, color, and typography across slides;',
  '- final quality audit performed against the live deck.',
].join('\n');

const SURFACE_HARNESSES: Readonly<Record<string, string>> = {
  office: OFFICE_HARNESS,
};

/** Build the operational harness attached to a resolved surface, if one exists. */
export const buildSurfaceHarnessPrompt = (surface: ResolvedSurface | undefined): string => {
  if (!surface) return '';
  return SURFACE_HARNESSES[surface.manifest.id] ?? '';
};
