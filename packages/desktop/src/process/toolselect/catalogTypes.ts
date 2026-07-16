/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the tool/skill self-selection layer (Yêu cầu 7). Kept in one
 * module so `catalog`, `keywordFilter`, `semanticFilter`, `selectionLog` and
 * `toolSelector` reuse the same shapes without circular imports.
 *
 * Process boundary: Main-process (Node.js) types only — no DOM, no runtime.
 */

/** Where a catalog entry originates. */
export type CatalogSource = 'skill' | 'mcpTool';

/**
 * One selectable capability — a skill or an MCP tool — with the short
 * description that filtering relies on (criterion 7.1: "Mỗi kỹ năng và công cụ
 * PHẢI có mô tả ngắn").
 */
export type CatalogEntry = {
  /** Stable unique id (e.g. `skill:pptx`, `mcp:browser_open`). */
  id: string;
  /** Whether this entry is a skill or an MCP tool. */
  source: CatalogSource;
  /** Human-readable name. */
  name: string;
  /** Short description of what it does (used for keyword + semantic matching). */
  description: string;
  /** Optional keyword tags to boost keyword matching. */
  keywords?: string[];
  /** For MCP tools, the server they belong to (display/grouping only). */
  server?: string;
};

/** A catalog entry paired with a relevance score and the reason it matched. */
export type ScoredEntry = {
  /** The matched catalog entry. */
  entry: CatalogEntry;
  /** Relevance score (higher = more relevant). Scale is filter-specific. */
  score: number;
  /** Human-readable reason the entry was selected (for transparency). */
  reason: string;
};
