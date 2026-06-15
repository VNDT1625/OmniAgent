/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Theme bridge for the xterm.js terminal renderer.
 *
 * xterm needs a concrete {@link ITheme} (hex colors), but the app's surfaces are
 * driven by CSS custom properties (semantic tokens) that flip between light and
 * dark. {@link buildXtermTheme} reads the current token values off the document
 * root so the terminal background/foreground always match the surrounding panel,
 * and pairs them with a fixed, legible 16-color ANSI palette chosen per scheme
 * (mirrors the VS Code default palettes for familiarity).
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import type { ITheme } from '@xterm/xterm';

/** Whether the app is currently in dark mode (per the `data-theme` attribute). */
export const isDarkScheme = (): boolean => {
  if (typeof document === 'undefined') return false;
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return false;
};

/** Read a CSS custom property off the document root, with a fallback. */
const readToken = (name: string, fallback: string): string => {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
};

/** ANSI 16-color palette for dark mode (VS Code-like). */
const DARK_ANSI = {
  black: '#1a1a1a',
  red: '#f14c4c',
  green: '#23d18b',
  yellow: '#e5c07b',
  blue: '#3b8eea',
  magenta: '#d670d6',
  cyan: '#29b8db',
  white: '#d9d9d9',
  brightBlack: '#5a5a5a',
  brightRed: '#ff6e6e',
  brightGreen: '#4ee6a4',
  brightYellow: '#f5d68a',
  brightBlue: '#62a8ff',
  brightMagenta: '#e58fe5',
  brightCyan: '#56cfe8',
  brightWhite: '#ffffff',
};

/** ANSI 16-color palette for light mode. */
const LIGHT_ANSI = {
  black: '#1d2129',
  red: '#cd3131',
  green: '#108548',
  yellow: '#b08800',
  blue: '#0a5fd4',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#4e5969',
  brightBlack: '#86909c',
  brightRed: '#e34234',
  brightGreen: '#15a55c',
  brightYellow: '#c79400',
  brightBlue: '#1a73e8',
  brightMagenta: '#d633d6',
  brightCyan: '#16b0d6',
  brightWhite: '#0c0e12',
};

/**
 * Build an xterm {@link ITheme} from the current semantic tokens + theme scheme.
 * Background uses `--bg-1` (the panel surface), foreground uses `--text-primary`.
 */
export const buildXtermTheme = (): ITheme => {
  const dark = isDarkScheme();
  const ansi = dark ? DARK_ANSI : LIGHT_ANSI;
  const background = readToken('--bg-1', dark ? '#1a1a1a' : '#f9fafb');
  const foreground = readToken('--text-primary', dark ? '#ffffff' : '#000000');
  const cursor = readToken('--color-primary-6', dark ? '#62a8ff' : '#0a5fd4');
  const selection = dark ? 'rgba(98,168,255,0.30)' : 'rgba(10,95,212,0.20)';

  return {
    background,
    foreground,
    cursor,
    cursorAccent: background,
    selectionBackground: selection,
    ...ansi,
  };
};
