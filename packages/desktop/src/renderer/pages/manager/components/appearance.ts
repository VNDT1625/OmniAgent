/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Map the user's {@link ManagerAppearance} settings to concrete CSS variables +
 * a font-family, applied as inline styles on the Manager root container. This
 * gives a Notion-style "make it yours" experience — accent colour, font, base
 * size, density spacing, and an optional tinted page background — without
 * touching global theme or other pages.
 *
 * Colours are real values here (not semantic tokens) **by design**: the user is
 * picking an accent, so we expose a small curated palette that reads well in
 * both light and dark. Everything is scoped to the Manager root via local CSS
 * variables the Manager components reference, so it never leaks elsewhere.
 *
 * Renderer-only, pure. No Node.js APIs.
 */

import type React from 'react';
import type { AccentColor, FontChoice, ManagerAppearance } from '@process/manager/managerTypes';

/** Accent palette: [main, light-1 (subtle bg), light-2 (hover bg)]. */
const ACCENT_PALETTE: Record<AccentColor, { main: string; light1: string; light2: string; tint: string }> = {
  blue: {
    main: '#3b6cf6',
    light1: 'rgba(59,108,246,0.10)',
    light2: 'rgba(59,108,246,0.18)',
    tint: 'rgba(59,108,246,0.04)',
  },
  violet: {
    main: '#7c5cff',
    light1: 'rgba(124,92,255,0.10)',
    light2: 'rgba(124,92,255,0.18)',
    tint: 'rgba(124,92,255,0.04)',
  },
  green: {
    main: '#15a06a',
    light1: 'rgba(21,160,106,0.10)',
    light2: 'rgba(21,160,106,0.18)',
    tint: 'rgba(21,160,106,0.04)',
  },
  orange: {
    main: '#e8730c',
    light1: 'rgba(232,115,12,0.10)',
    light2: 'rgba(232,115,12,0.18)',
    tint: 'rgba(232,115,12,0.04)',
  },
  red: {
    main: '#e54545',
    light1: 'rgba(229,69,69,0.10)',
    light2: 'rgba(229,69,69,0.18)',
    tint: 'rgba(229,69,69,0.04)',
  },
  pink: {
    main: '#e8579f',
    light1: 'rgba(232,87,159,0.10)',
    light2: 'rgba(232,87,159,0.18)',
    tint: 'rgba(232,87,159,0.04)',
  },
  teal: {
    main: '#0ca7a0',
    light1: 'rgba(12,167,160,0.10)',
    light2: 'rgba(12,167,160,0.18)',
    tint: 'rgba(12,167,160,0.04)',
  },
};

/**
 * Font-family stacks per choice.
 *
 * We deliberately lead with system fonts (not a bundled webfont like Inter):
 * the project's bundled Inter subset renders Vietnamese diacritics poorly, and
 * the OS system fonts (Segoe UI / San Francisco / Noto / PingFang) cover the
 * full Vietnamese character set with correct tone marks. Each stack ends with
 * broad CJK/Latin fallbacks so non-Latin scripts also render correctly.
 */
const VIET_FALLBACK =
  "'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei'";
const FONT_STACK: Record<FontChoice, string> = {
  default: `system-ui, -apple-system, BlinkMacSystemFont, ${VIET_FALLBACK}, sans-serif`,
  serif: `'Lora', Georgia, 'Times New Roman', 'Noto Serif', 'Source Han Serif', serif`,
  mono: `'JetBrains Mono', ui-monospace, 'SF Mono', Consolas, 'Liberation Mono', monospace`,
  rounded: `'Nunito', 'Quicksand', system-ui, ${VIET_FALLBACK}, sans-serif`,
};

/** All accents in display order, for the picker. */
export const ACCENT_COLORS: readonly AccentColor[] = ['blue', 'violet', 'green', 'orange', 'red', 'pink', 'teal'];
/** All fonts in display order. */
export const FONT_CHOICES: readonly FontChoice[] = ['default', 'serif', 'mono', 'rounded'];

/** The swatch colour for an accent (for the picker dots). */
export const accentSwatch = (accent: AccentColor): string => ACCENT_PALETTE[accent].main;

/**
 * Build the inline style object applied to the Manager root. Manager components
 * read these via `var(--mgr-accent)` etc. (set up in the page wrapper), so a
 * change here re-themes the whole workspace instantly.
 */
export const appearanceStyle = (a: ManagerAppearance): React.CSSProperties => {
  const palette = ACCENT_PALETTE[a.accent] ?? ACCENT_PALETTE.blue;
  const gap = a.density === 'compact' ? '6px' : '10px';
  const pad = a.density === 'compact' ? '8px' : '12px';
  return {
    // Accent variables consumed by Manager components.
    ['--mgr-accent' as string]: palette.main,
    ['--mgr-accent-light-1' as string]: palette.light1,
    ['--mgr-accent-light-2' as string]: palette.light2,
    ['--mgr-density-gap' as string]: gap,
    ['--mgr-density-pad' as string]: pad,
    fontFamily: FONT_STACK[a.font] ?? FONT_STACK.default,
    fontSize: `${a.fontSize}px`,
    background: a.tintedBackground ? palette.tint : undefined,
  };
};
