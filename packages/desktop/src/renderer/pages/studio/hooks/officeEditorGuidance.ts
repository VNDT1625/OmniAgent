/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Standing instructions injected into the Studio editor chat's rules layer when
 * the built-in **Office-editor** MCP server is attached.
 *
 * The editor chat embeds the main `<ChatConversation>` and attaches the
 * `aionui-office-editor` MCP server so a CLI agent (Claude Code / Codex / Gemini)
 * can edit the LIVE document the user has open with fast, formatting-preserving
 * tools (`office_*`). Without explicit guidance the agent does not know which
 * file the panel is bound to, nor that the `office_*` tools edit the live editor
 * (rather than reading/writing bytes by path). These rules tell it both.
 *
 * Renderer-only module: a pure string builder, no side effects. The MCP server
 * name is duplicated here (kept in sync with the Main-process constant) so the
 * renderer never imports the Node-only server module.
 */

/** Canonical name of the built-in Office-editor MCP server (mirror constant). */
export const OFFICE_EDITOR_MCP_NAME = 'aionui-office-editor';

/**
 * Build the standing-instructions block for the editor chat. The open file path
 * is embedded so the agent targets the right document without being told.
 *
 * @param filePath Absolute path of the document open in the editor.
 */
export const buildOfficeEditorRules = (filePath: string): string =>
  [
    '## Document editor (you can edit the open file live)',
    '',
    `The user has this file open in the Studio editor: \`${filePath}\``,
    'You can edit it directly through the embedded `office_*` tools. Your edits appear in the live',
    "editor the user is watching - they keep the document's full formatting (this is NOT a",
    'read-bytes / write-bytes round-trip).',
    '',
    'Tools (call them with this exact file path):',
    '- `office_read_document` - read the current document text. Call this before planning edits.',
    '- `office_search_replace` - replace every occurrence of a string. Works for Word, sheets, and slides.',
    '- `office_replace_passage` - replace ONE specific passage (Word), located by an anchor.',
    '- `office_insert_text` / `office_append_text` - insert at the cursor / append a paragraph (Word).',
    '- `office_replace_all` - replace the WHOLE document (Word only).',
    '- `office_apply_headings` / `office_insert_toc` - heading styles + an auto table of contents (Word).',
    '- `office_format_text` / `office_format_passage` - bold/italic/color/size/font on text (Word).',
    '- `office_insert_table` (Word) / `office_set_cells` (spreadsheet).',
    '- `office_create_premium_doc` / `office_create_premium_deck` - build polished structured deliverables.',
    '- `office_review_premium_quality` - audit premium DOCX/PPTX structure, density, proof, and slide visuals.',
    '- `office_run_api` - run bounded ONLYOFFICE Document Builder API code for anything not covered above.',
    '  For PPTX/slides, use `Api.GetPresentation()` here for structural edits such as adding slides,',
    '  shapes, images, layout changes, speaker notes, or targeted formatting that the simple tools do not cover.',
    '',
    'Production deck/doc quality bar:',
    '- For PPTX creation or major redesign, produce a real designed deck: visual system, clear hierarchy,',
    '  strong covers/dividers, tasteful imagery, diagrams/charts where useful, consistent typography,',
    '  speaker-friendly density, and slide transitions/effects only when they improve comprehension.',
    '- Prefer generated or user-provided images over generic placeholders. Insert images through Office APIs',
    '  or the available image-generation workflow, then place/crop them intentionally in the deck.',
    '- For DOCX creation or major redesign, use real document structure: title page, heading styles, TOC,',
    '  tables, callouts, image blocks, page setup, and consistent typography instead of plain text dumps.',
    '',
    'Rules:',
    '- To change THIS document, ALWAYS use the `office_*` tools - they edit the live editor and preserve',
    '  formatting. Prefer the specific tools; use `office_run_api` only for what they do not cover.',
    '- Read the document first with `office_read_document`, including PPTX files, before deciding what to change.',
    '- For simple slide text edits, prefer `office_search_replace` or `office_insert_text` if the cursor/selection',
    '  is the intended target; use `office_run_api` for slide-level operations.',
    '- Never edit the open `.docx`, `.xlsx`, or `.pptx` by shelling out, unzipping, rewriting XML, or saving',
    '  bytes directly. Those paths bypass the live editor and can corrupt formatting/collaboration state.',
    '- After a mutating tool call, verify the result with `office_read_document` or another targeted `office_*`',
    '  observation before reporting completion.',
    '- For any premium DOCX/PPTX creation or major redesign, call `office_review_premium_quality` before',
    '  the final response. If it lists required improvements, revise with `office_*` tools and audit again.',
    '- Make the smallest change that satisfies the user. Do NOT rewrite the whole file for a small edit.',
    '- The `office_*` tools require the document to be open in "Edit (Office)" mode. If a tool reports the',
    '  editor is not ready, tell the user to open the document for editing, then retry.',
  ].join('\n');

/**
 * Append the Office-editor rules to an existing rules string (idempotent).
 *
 * @param existingRules The conversation's current rules (may be empty/undefined).
 * @param filePath      The open document's path, embedded into the rules.
 */
export const withOfficeEditorRules = (existingRules: string | undefined, filePath: string): string => {
  const base = (existingRules ?? '').trim();
  if (base.includes('Document editor (you can edit the open file live)')) return base; // already present
  const block = buildOfficeEditorRules(filePath);
  return base.length > 0 ? `${base}\n\n${block}` : block;
};
