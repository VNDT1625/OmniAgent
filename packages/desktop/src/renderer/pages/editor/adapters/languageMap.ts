/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Map a file extension to a Monaco editor language id (Yêu cầu 2a, criterion
 * 2.1 — "mọi ngôn ngữ lập trình"). Pure and renderer-safe.
 */

import { getFileExtension } from '../editorRegistry';

/** Extension (no dot, lowercase) → Monaco language id. */
const EXTENSION_LANGUAGE: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  json: 'json',
  json5: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  env: 'ini',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  rb: 'ruby',
  php: 'php',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  swift: 'swift',
  scala: 'scala',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  pl: 'perl',
  pm: 'perl',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  vue: 'html',
  svelte: 'html',
  astro: 'html',
  gradle: 'groovy',
  groovy: 'groovy',
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hrl: 'erlang',
  hs: 'plaintext',
  ml: 'plaintext',
  fs: 'fsharp',
  fsx: 'fsharp',
  vb: 'vb',
  proto: 'proto',
  tf: 'hcl',
  tfvars: 'hcl',
  hcl: 'hcl',
  dockerfile: 'dockerfile',
  csv: 'plaintext',
  tsv: 'plaintext',
  log: 'plaintext',
  txt: 'plaintext',
  text: 'plaintext',
  diff: 'plaintext',
  patch: 'plaintext',
};

/**
 * Resolve a Monaco language id for a file path. Falls back to `'plaintext'`.
 *
 * @param fileName A file name or full path.
 * @returns The Monaco language id (never empty).
 */
export const languageForFile = (fileName: string): string => {
  const ext = getFileExtension(fileName);
  if (ext && EXTENSION_LANGUAGE[ext]) return EXTENSION_LANGUAGE[ext];
  // Extensionless well-known files (Dockerfile, Makefile) → best-effort.
  const lower = fileName.toLowerCase();
  if (lower.endsWith('dockerfile')) return 'dockerfile';
  if (lower.endsWith('makefile')) return 'makefile';
  return 'plaintext';
};
